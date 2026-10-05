import { timingSafeEqual } from 'node:crypto';

import { DOMAIN_HOST_PATTERN } from '@deveye/types/sdk/server';
import type { FastifyInstance } from 'fastify';

import type { FeatureDomainsRepo } from '@/db/repos/featureDomains';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleWebDomainFeatures } from '@/features/_sdk/register';
import { planPausedIds } from '@/Services/planPauses';
import { env } from '@/Utils/Env';
import { pointsHere, systemWeb, type WebSeam } from './web';

/**
 * Les domaines web des clients, tels que Traefik les lit par son fournisseur
 * HTTP (`providers.http`) : un routeur par nom vers l'écouteur public, avec le
 * résolveur de certificats du proxy. C'est ce qui rend un domaine joignable en
 * HTTPS sans que personne ne touche au serveur.
 *
 * Un nom n'entre que prouvé par son TXT et, tant qu'il n'a jamais été vérifié,
 * que s'il pointe déjà ici : Traefik ne redemande pas un certificat refusé tant
 * que sa configuration ne bouge pas, et son compte ACME sert tout le serveur.
 */

export const PROXY_PATH = '/api/domains/proxy';

const SERVICE = 'deveye-domains';

/** Un nom qui pointe se relit rarement, un nom qui ne pointe pas encore souvent. */
const POINTS_OK_MS = 10 * 60_000;
const POINTS_NO_MS = 60_000;

/** Les certificats s'obtiennent-ils seuls sur cette instance ? */
export function httpsMode(): 'auto' | 'manual' {
    return env.DOMAIN_PROXY_TOKEN ? 'auto' : 'manual';
}

export interface ProxySettings {
    upstream: string;
    certResolver: string;
    entryPoint: string;
}

interface TraefikRouter {
    rule: string;
    entryPoints: string[];
    service: string;
    tls: { certResolver: string };
}

export interface TraefikConfig {
    http: {
        routers: Record<string, TraefikRouter>;
        services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
    };
}

export function createProxyConfig(
    repo: Pick<FeatureDomainsRepo, 'routable'>,
    settings: ProxySettings,
    opts: {
        features: () => readonly string[];
        /** Les lignes que l'offre de leur propriétaire tient en pause : leur nom n'est plus routé. */
        pausedIds?: () => readonly string[];
        /** L'origine publique, vers laquelle un nom doit pointer. */
        publicHost: string;
        /** Les noms de DevEye lui-même, qu'aucun client ne peut réclamer. */
        reserved: readonly string[];
        seam?: WebSeam;
        clock?: () => number;
    }
): () => Promise<TraefikConfig> {
    const seam = opts.seam ?? systemWeb;
    const clock = opts.clock ?? Date.now;
    const reserved = new Set(opts.reserved);
    const cache = new Map<string, { ok: boolean; until: number }>();

    const points = async (host: string): Promise<boolean> => {
        const now = clock();
        const held = cache.get(host);
        if (held && held.until > now) return held.ok;
        const ok = await pointsHere(host, opts.publicHost, seam).catch(() => false);
        cache.set(host, { ok, until: now + (ok ? POINTS_OK_MS : POINTS_NO_MS) });
        return ok;
    };

    return async () => {
        const rows = await repo.routable(opts.features(), opts.pausedIds?.() ?? []);
        const listed = new Set(rows.map((row) => row.host));
        for (const host of cache.keys()) if (!listed.has(host)) cache.delete(host);

        const kept = await Promise.all(
            rows.map(async (row) => {
                // Le motif exclut l'accent grave : rien ne peut sortir de `Host(`…`)`.
                if (!DOMAIN_HOST_PATTERN.test(row.host) || reserved.has(row.host)) return null;
                return row.verified || (await points(row.host)) ? row.host : null;
            })
        );

        const routers: Record<string, TraefikRouter> = {};
        for (const host of kept) {
            if (host === null) continue;
            routers[`deveye-${host.replaceAll('.', '_')}`] = {
                rule: `Host(\`${host}\`)`,
                entryPoints: [settings.entryPoint],
                service: SERVICE,
                tls: { certResolver: settings.certResolver }
            };
        }
        return {
            http: {
                routers,
                services: { [SERVICE]: { loadBalancer: { servers: [{ url: settings.upstream }] } } }
            }
        };
    };
}

let lastReadAt: number | null = null;

/** Millisecondes : la dernière lecture de la liste par le proxy, depuis le démarrage de ce processus. */
export function proxyLastReadAt(): number | null {
    return lastReadAt;
}

/** Sur l'écouteur principal seulement, et muette sans le bon jeton : un 404 ne dit pas qu'elle existe. */
export function registerProxyRoute(app: FastifyInstance, repo: FeatureDomainsRepo): void {
    const token = env.DOMAIN_PROXY_TOKEN;
    const upstream = env.DOMAIN_PROXY_UPSTREAM;
    if (!token || !upstream) return;

    const build = createProxyConfig(
        repo,
        { upstream, certResolver: env.DOMAIN_PROXY_CERT_RESOLVER, entryPoint: env.DOMAIN_PROXY_ENTRYPOINT },
        {
            features: moduleWebDomainFeatures,
            pausedIds: () => planPausedIds('domains.hosts'),
            publicHost: new URL(ORIGINS.public).hostname,
            reserved: [new URL(ORIGINS.app).hostname, new URL(ORIGINS.public).hostname]
        }
    );
    const expected = Buffer.from(`Bearer ${token}`);

    // Silencieuse : Traefik l'interroge toutes les quelques secondes.
    app.get(PROXY_PATH, { logLevel: 'silent' }, async (req, reply) => {
        const given = Buffer.from(req.headers.authorization ?? '');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            return reply.code(404).send();
        }
        lastReadAt = Date.now();
        return reply.header('cache-control', 'no-store').send(await build());
    });
}
