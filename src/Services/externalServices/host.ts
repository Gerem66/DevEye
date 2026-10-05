import type { ExternalService, ExternalServiceFact } from '@deveye/types';

import { status } from '@/status';
import { proxyLastReadAt } from '@/Services/domains/proxy';
import { objectStorageUsage, probeObjectStorage, type ObjectStorageUsage } from '@/Services/objectStorage';
import { sizeFr } from '@/Services/quota';
import { serverMail } from '@/Services/serverMail';
import { statusProbeLastReadAt } from '@/Services/statusProbe';
import { env } from '@/Utils/Env';

/** Le premier palier de prix d'OVHcloud Object Storage : 50 Tio. */
const OBJECT_STORAGE_TIER_BYTES = 50 * 1024 ** 4;
/** Lister tout le bucket coûte une requête par millier d'objets : une mesure par heure au plus. */
const USAGE_MEMO_MS = 3600_000;
/** Ce qu'une lecture de la page attend la mesure ; au-delà, elle continue et sert la suivante. */
const USAGE_WAIT_MS = 5_000;
/** Traefik relit la liste toutes les quelques secondes, la page d'état sonde chaque minute. */
const SILENT_AFTER_MS = 5 * 60_000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

const ago = (at: number, now: number): string => {
    const minutes = Math.round((now - at) / 60_000);
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    return `il y a ${Math.round(minutes / 60)} h`;
};

const euros = (amount: number): string =>
    amount.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

let usageMemo: { at: number; value: ObjectStorageUsage } | null = null;
let usageRun: Promise<void> | null = null;

/** La dernière mesure, relancée quand elle a vieilli, sans jamais en lancer deux à la fois. */
async function storageUsage(refresh: boolean): Promise<{ at: number; value: ObjectStorageUsage } | null> {
    const stale = !usageMemo || refresh || Date.now() - usageMemo.at > USAGE_MEMO_MS;
    if (stale && !usageRun) {
        usageRun = objectStorageUsage()
            .then((value) => {
                if (value) usageMemo = { at: Date.now(), value };
            })
            .catch(() => undefined)
            .finally(() => {
                usageRun = null;
            });
    }
    if (usageRun) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wait = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, USAGE_WAIT_MS);
        });
        await Promise.race([usageRun, wait]).finally(() => clearTimeout(timer));
    }
    return usageMemo;
}

function providerOf(endpoint: string): string | undefined {
    try {
        const host = new URL(endpoint).hostname;
        return /(^|\.)ovh(cloud)?\./.test(host) ? 'OVHcloud' : host;
    } catch {
        return undefined;
    }
}

/** Ce qui nomme une carte de l'hôte, même quand sa sonde ne répond pas. */
export interface HostBase {
    id: string;
    name: string;
}

async function objectStorage(base: HostBase, refresh: boolean): Promise<ExternalService> {
    if (!env.STORAGE_S3_ENDPOINT) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Aucun bucket configuré : les fichiers des modules vont sur le disque du serveur.'
        };
    }
    const facts: ExternalServiceFact[] = [
        { label: 'Bucket', value: env.STORAGE_S3_BUCKET ?? '' },
        { label: 'Région', value: env.STORAGE_S3_REGION ?? '' }
    ];
    const provider = providerOf(env.STORAGE_S3_ENDPOINT);
    try {
        await probeObjectStorage();
    } catch (e) {
        return {
            ...base,
            provider,
            state: 'down',
            summary: 'Le bucket ne répond pas : les envois de fichiers échouent.',
            facts: [...facts, { label: 'Erreur', value: errorText(e), tone: 'danger' }]
        };
    }
    const usage = await storageUsage(refresh);
    if (!usage) {
        return {
            ...base,
            provider,
            state: 'ok',
            summary: 'Le bucket répond. L’espace occupé est en cours de mesure.',
            facts
        };
    }
    const { bytes, objects, instanceBytes } = usage.value;
    facts.push({ label: 'Objets', value: objects.toLocaleString('fr-FR') });
    if (env.STORAGE_S3_PREFIX) {
        facts.push({ label: `Part de cette instance (${env.STORAGE_S3_PREFIX})`, value: sizeFr(instanceBytes) });
    }
    const price = env.STORAGE_S3_PRICE_PER_GB;
    facts.push(
        price === undefined
            ? { label: 'Coût estimé', value: 'Tarif non renseigné (STORAGE_S3_PRICE_PER_GB)', tone: 'warning' }
            : { label: 'Coût estimé', value: `${euros((bytes / 1024 ** 3) * price)} HT par mois` }
    );
    facts.push({ label: 'Mesuré', value: ago(usage.at, Date.now()) });
    return {
        ...base,
        provider,
        state: 'ok',
        summary: 'Le bucket répond à un aller-retour de test.',
        facts,
        meters: [
            {
                label: 'Espace occupé, sur le premier palier de prix',
                used: bytes,
                limit: OBJECT_STORAGE_TIER_BYTES,
                unit: 'bytes',
                note:
                    bytes > OBJECT_STORAGE_TIER_BYTES
                        ? 'Au-delà de 50 Tio, le Go coûte moins cher : l’estimation est majorée.'
                        : undefined
            }
        ]
    };
}

async function smtp(base: HostBase): Promise<ExternalService> {
    if (!serverMail.configured) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Aucun serveur SMTP : les liens d’inscription sont écrits dans le journal du serveur.'
        };
    }
    const facts: ExternalServiceFact[] = [
        { label: 'Serveur', value: `${env.SMTP_HOST}:${env.SMTP_PORT}` },
        { label: 'Expéditeur', value: env.SMTP_FROM ?? '' }
    ];
    try {
        await serverMail.verify();
        return { ...base, state: 'ok', summary: 'Le serveur accepte la connexion et les identifiants.', facts };
    } catch (e) {
        return {
            ...base,
            state: 'down',
            summary: 'Le serveur refuse la connexion : aucun mail du serveur ne part.',
            facts: [...facts, { label: 'Erreur', value: errorText(e), tone: 'danger' }]
        };
    }
}

async function agentReleases(host: HostBase): Promise<ExternalService> {
    const base = { ...host, provider: 'GitHub' };
    if (!env.AGENT_DOWNLOAD_TOKEN || !env.AGENT_REPO) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Synchronisation désactivée : le serveur sert les binaires déjà sur son disque.'
        };
    }
    const task = status.snapshot().tasks.find((t) => t.id === 'agent-sync');
    const facts: ExternalServiceFact[] = [
        { label: 'Dépôt', value: env.AGENT_REPO },
        { label: 'Étiquette', value: env.AGENT_RELEASE_TAG || 'agent-latest' }
    ];
    if (task?.detail) facts.push({ label: 'Détail', value: task.detail });
    if (task?.error) facts.push({ label: 'Erreur', value: task.error, tone: 'danger' });
    switch (task?.state) {
        case 'done':
            return { ...base, state: 'ok', summary: 'Les binaires de cette version sont à jour.', facts };
        case 'warning':
            return { ...base, state: 'degraded', summary: 'Le serveur sert une version plus ancienne.', facts };
        case 'error':
            return { ...base, state: 'down', summary: 'La synchronisation a échoué.', facts };
        default:
            return { ...base, state: 'degraded', summary: 'Synchronisation en cours.', facts };
    }
}

/** Un client qui vient lire le serveur : vu récemment, il fonctionne. */
function pollingClient(
    base: HostBase & { provider?: string },
    lastReadAt: number | null,
    facts: ExternalServiceFact[]
): ExternalService {
    const now = Date.now();
    if (lastReadAt !== null) facts.push({ label: 'Dernière lecture', value: ago(lastReadAt, now) });
    if (lastReadAt !== null && now - lastReadAt < SILENT_AFTER_MS) {
        return { ...base, state: 'ok', summary: 'Vient lire le serveur régulièrement.', facts };
    }
    if (lastReadAt === null && process.uptime() * 1000 < SILENT_AFTER_MS) {
        return { ...base, state: 'ok', summary: 'Serveur démarré il y a peu : pas encore de lecture.', facts };
    }
    return {
        ...base,
        state: 'degraded',
        summary:
            lastReadAt === null
                ? 'Aucune lecture depuis le démarrage du serveur : le jeton ou l’adresse ne concordent peut-être pas.'
                : 'Plus de lecture depuis plusieurs minutes.',
        facts
    };
}

async function domainProxy(host: HostBase): Promise<ExternalService> {
    const base = { ...host, provider: 'Traefik' };
    if (!env.DOMAIN_PROXY_TOKEN || !env.DOMAIN_PROXY_UPSTREAM) {
        return {
            ...base,
            state: 'inactive',
            summary: 'Sans DOMAIN_PROXY_TOKEN, chaque domaine s’ajoute au proxy à la main.'
        };
    }
    return pollingClient(base, proxyLastReadAt(), [
        { label: 'Certificats', value: env.DOMAIN_PROXY_CERT_RESOLVER },
        { label: 'Amont', value: env.DOMAIN_PROXY_UPSTREAM }
    ]);
}

async function statusPage(base: HostBase): Promise<ExternalService> {
    if (!env.STATUS_PAGE_URL || !env.STATUS_PROBE_TOKEN) {
        return { ...base, state: 'inactive', summary: 'Aucune page d’état ne surveille ce serveur.' };
    }
    return pollingClient(base, statusProbeLastReadAt(), [{ label: 'Adresse', value: env.STATUS_PAGE_URL }]);
}

/** Ce que l'hôte sait de ses propres dépendances, sans module. */
export function hostServices(refresh: boolean): { base: HostBase; read: Promise<ExternalService> }[] {
    const probes: [HostBase, (base: HostBase) => Promise<ExternalService>][] = [
        [{ id: 'object-storage', name: 'Stockage objet (S3)' }, (base) => objectStorage(base, refresh)],
        [{ id: 'smtp', name: 'Envoi des mails du serveur' }, smtp],
        [{ id: 'agent-releases', name: 'Versions de l’agent' }, agentReleases],
        [{ id: 'domain-proxy', name: 'Domaines des clients' }, domainProxy],
        [{ id: 'status-page', name: 'Page d’état' }, statusPage]
    ];
    return probes.map(([base, probe]) => ({ base, read: probe(base) }));
}
