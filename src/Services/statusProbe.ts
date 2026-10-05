import { timingSafeEqual } from 'node:crypto';

import { SYSTEM_NOTIFICATION_TARGET, type FeatureMaintenanceLevel } from '@deveye/types';
import type { SdkServiceHealth } from '@deveye/types/sdk/server';
import type { FastifyInstance } from 'fastify';

import type { Database } from '@/db';
import { moduleManifests, moduleServiceHealth } from '@/features/_sdk/register';
import type Encryption from '@/Services/Encryption';
import { featureHealth, type FeatureHealthReport } from '@/Services/featureHealth';
import { maintenance } from '@/Services/maintenance';
import { resolveRoute } from '@/Services/notifications';
import { createOpenCipher } from '@/Services/SecureStore';
import {
    STATUS_CHANNELS_PATH,
    STATUS_PROBE_PATH,
    STATUS_TRACKING_PATH,
    type FeatureState,
    type StatusChannels,
    type StatusProbe,
    type StatusTracking
} from '@/Services/statusProbeContract';
import { appVersion } from '@/version';
import { env } from '@/Utils/Env';

/**
 * Les trois routes que la page d'état interroge : l'état du serveur et de
 * chaque module, les destinations des alertes Système, et la balise Audience
 * qu'elle embarque. Sur l'écouteur principal, muettes sans le jeton
 * (`STATUS_PROBE_TOKEN`) : un 404 ne dit pas qu'elles existent.
 */

/** La page passe toutes les minutes ; plusieurs pages ou un rechargement ne recalculent rien. */
export const PROBE_CACHE_MS = 15_000;
const DB_PING_MS = 2_000;

export interface ProbeSources {
    version(): string;
    pingDatabase(): Promise<boolean>;
    site(): { down: boolean; message: string; priority: boolean };
    features(): readonly { id: string; label: string }[];
    level(featureId: string): FeatureMaintenanceLevel | null;
    health(featureId: string): FeatureHealthReport;
    serviceHealth(featureId: string): Promise<SdkServiceHealth | null>;
}

const SEVERITY: Record<Exclude<FeatureState, 'maintenance'>, number> = { up: 0, degraded: 1, down: 2 };

/** L'état d'un module : sa maintenance d'abord, sinon le pire de ce que l'hôte et lui-même en disent. */
async function featureEntry(src: ProbeSources, id: string, label: string): Promise<StatusProbe['features'][number]> {
    const level = src.level(id);
    if (level === 'requests' || level === 'full') return { id, label, state: 'maintenance', reason: null };
    const host = src.health(id);
    const own = await src.serviceHealth(id);
    if (own && SEVERITY[own.state] > SEVERITY[host.state]) {
        return { id, label, state: own.state, reason: own.reason ?? null };
    }
    return { id, label, state: host.state, reason: host.reason };
}

export async function buildProbe(src: ProbeSources): Promise<StatusProbe> {
    const site = src.site();
    // La préversion cache le module à qui n'est pas administrateur : la page publique aussi.
    const shown = src.features().filter((f) => src.level(f.id) !== 'preview');
    const [database, features] = await Promise.all([
        src.pingDatabase(),
        Promise.all(shown.map((f) => featureEntry(src, f.id, f.label)))
    ]);
    return {
        version: src.version(),
        database,
        site: {
            state: site.down ? 'maintenance' : site.priority ? 'degraded' : 'up',
            message: site.down ? site.message : null
        },
        features
    };
}

/** Une valeur recalculée au plus toutes les `ms`, un seul calcul à la fois. */
export function cachedLoader<T>(load: () => Promise<T>, ms: number, clock: () => number = Date.now) {
    let held: { value: T; until: number } | null = null;
    let pending: Promise<T> | null = null;
    return (): Promise<T> => {
        if (held && held.until > clock()) return Promise.resolve(held.value);
        pending ??= load()
            .then((value) => {
                held = { value, until: clock() + ms };
                return value;
            })
            .finally(() => {
                pending = null;
            });
        return pending;
    };
}

/** Les canaux Système prêts à livrer, de tous les espaces qui en ont routé. */
async function systemChannels(db: Database, crypt: Encryption): Promise<StatusChannels> {
    const webhooks = new Map<string, StatusChannels['webhooks'][number]>();
    const emails = new Set<string>();
    for (const workspaceId of await db.notificationChannels.systemRouteWorkspaces()) {
        const cipher = createOpenCipher(db, crypt, workspaceId);
        for (const channel of await resolveRoute(db, cipher, workspaceId, SYSTEM_NOTIFICATION_TARGET)) {
            if (channel.email) emails.add(channel.email.to);
            else if (channel.webhookUrl && channel.kind !== 'email') {
                webhooks.set(channel.webhookUrl, { kind: channel.kind, url: channel.webhookUrl });
            }
        }
    }
    return { webhooks: [...webhooks.values()], emails: [...emails] };
}

let lastProbedAt: number | null = null;

/** Millisecondes : la dernière sonde de la page d'état, depuis le démarrage de ce processus. */
export function statusProbeLastReadAt(): number | null {
    return lastProbedAt;
}

export function registerStatusProbeRoutes(
    app: FastifyInstance,
    deps: { db: Database; crypt: Encryption; tracking(): StatusTracking }
): void {
    const token = env.STATUS_PROBE_TOKEN;
    if (!token) return;
    const expected = Buffer.from(`Bearer ${token}`);
    const authorized = (header: string | undefined): boolean => {
        const given = Buffer.from(header ?? '');
        return given.length === expected.length && timingSafeEqual(given, expected);
    };

    const sources: ProbeSources = {
        version: appVersion,
        pingDatabase: async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), DB_PING_MS);
            });
            const ping = deps.db.queryable.query('SELECT 1').then(
                () => true,
                () => false
            );
            return Promise.race([ping, late]).finally(() => clearTimeout(timer));
        },
        site: () => ({
            down: maintenance.siteDown(),
            message: maintenance.message(),
            priority: maintenance.priority()
        }),
        features: () => moduleManifests().map((m) => ({ id: m.id, label: m.label })),
        level: (id) => maintenance.featureLevel(id),
        health: (id) => featureHealth.of(id),
        serviceHealth: moduleServiceHealth
    };
    const probe = cachedLoader(() => buildProbe(sources), PROBE_CACHE_MS);
    const channels = cachedLoader(() => systemChannels(deps.db, deps.crypt), PROBE_CACHE_MS);

    app.get(STATUS_PROBE_PATH, { logLevel: 'silent' }, async (req, reply) => {
        if (!authorized(req.headers.authorization)) return reply.code(404).send();
        lastProbedAt = Date.now();
        return reply.header('cache-control', 'no-store').send(await probe());
    });
    app.get(STATUS_CHANNELS_PATH, { logLevel: 'silent' }, async (req, reply) => {
        if (!authorized(req.headers.authorization)) return reply.code(404).send();
        return reply.header('cache-control', 'no-store').send(await channels());
    });
    app.get(STATUS_TRACKING_PATH, { logLevel: 'silent' }, async (req, reply) => {
        if (!authorized(req.headers.authorization)) return reply.code(404).send();
        return reply.header('cache-control', 'no-store').send({ tracking: deps.tracking() });
    });
}
