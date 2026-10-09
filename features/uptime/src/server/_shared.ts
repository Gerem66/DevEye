import type {
    UptimeBaseline,
    UptimeDeploySource,
    UptimeIncident,
    UptimeIncidentRow,
    UptimeService,
    UptimeServiceRow
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkDomain, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { UptimeRepo } from './repo';
import type { UptimeMonitor } from './service';

export type Ctx = SdkFeatureContext<UptimeRepo>;

/** L'ordonnanceur, posé par `createService` au démarrage : un singleton par processus. */
let monitorRef: UptimeMonitor | null = null;

export function setMonitor(monitor: UptimeMonitor | null): void {
    monitorRef = monitor;
}

/** The scheduler, or a typed error when the server runs without it (tests). */
export function monitor(): UptimeMonitor {
    if (!monitorRef) throw new FeatureError('internal', 'Uptime monitor unavailable');
    return monitorRef;
}

/**
 * Encrypted part of a service (stored as `uptime_services.content`). Everything
 * else lives in clear columns so the scheduler can plan probes and the charts
 * can aggregate without decrypting a thing.
 */
export interface ServicePayload {
    name: string;
    url: string;
    keyword: string | null;
    /** Integrity: extra site-relative files to verify. */
    paths: string[];
    /** Integrity: accept a drift a deployment of the service's sources explains. */
    deployAccept: boolean;
}

export async function encryptService(cipher: SdkCipher, payload: ServicePayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * Decode a service's target. Falls back to blanks rather than throwing: a row
 * whose blob can't be read must still be listable (and deletable) instead of
 * breaking the whole feature.
 */
export async function decryptService(cipher: SdkCipher, content: string): Promise<ServicePayload> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { name: '', url: '', keyword: null, paths: [], deployAccept: false };
    try {
        const parsed = JSON.parse(plain) as Partial<ServicePayload>;
        return {
            name: typeof parsed.name === 'string' ? parsed.name : '',
            url: typeof parsed.url === 'string' ? parsed.url : '',
            keyword: typeof parsed.keyword === 'string' ? parsed.keyword : null,
            paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string') : [],
            deployAccept: parsed.deployAccept === true
        };
    } catch {
        return { name: '', url: '', keyword: null, paths: [], deployAccept: false };
    }
}

/**
 * What the integrity option compares against (`uptime_services.baseline_enc`,
 * open tier): the fingerprint of every file, and the document's policy.
 */
export interface IntegrityBaseline {
    capturedAt: number;
    /** The document's Content-Security-Policy header, `null` when it carries none. */
    csp: string | null;
    /** Site-relative path (leading slash) to SHA-256, hex. */
    files: Record<string, string>;
    source: 'manifest' | 'page';
}

export async function encryptBaseline(cipher: SdkCipher, baseline: IntegrityBaseline): Promise<string> {
    return cipher.encrypt(JSON.stringify(baseline));
}

/** An unreadable reference reads as "none yet": the next probe learns anew rather than alerting forever. */
export async function decryptBaseline(cipher: SdkCipher, blob: string | null): Promise<IntegrityBaseline | null> {
    if (blob === null) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        const parsed = JSON.parse(plain) as Partial<IntegrityBaseline>;
        if (typeof parsed.capturedAt !== 'number' || typeof parsed.files !== 'object' || parsed.files === null) {
            return null;
        }
        return {
            capturedAt: parsed.capturedAt,
            csp: typeof parsed.csp === 'string' ? parsed.csp : null,
            files: Object.fromEntries(
                Object.entries(parsed.files).filter((e): e is [string, string] => typeof e[1] === 'string')
            ),
            source: parsed.source === 'manifest' ? 'manifest' : 'page'
        };
    } catch {
        return null;
    }
}

/**
 * Ce qui tient chaque sonde en échec entre deux lectures des fichiers
 * (`uptime_services.integrity_verdict`, étage ouvert) : un écart, fichier par
 * fichier dans `lines`, ou des lectures ratées au-delà du seuil (`lines` vide).
 */
export interface IntegrityVerdict {
    error: string;
    lines: string[];
}

export async function encryptVerdict(cipher: SdkCipher, verdict: IntegrityVerdict | null): Promise<string | null> {
    return verdict === null ? null : cipher.encrypt(JSON.stringify(verdict));
}

/** Un verdict illisible vaut « fichiers conformes » : la prochaine lecture tranche. */
export async function decryptVerdict(cipher: SdkCipher, blob: string | null): Promise<IntegrityVerdict | null> {
    if (blob === null) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        const parsed = JSON.parse(plain) as Partial<IntegrityVerdict>;
        if (typeof parsed.error !== 'string') return null;
        const lines = Array.isArray(parsed.lines) ? parsed.lines.filter((l): l is string => typeof l === 'string') : [];
        return { error: parsed.error, lines };
    } catch {
        return null;
    }
}

/** The reference as the screen shows it: counts, never fingerprints. */
export function summarizeBaseline(baseline: IntegrityBaseline | null): UptimeBaseline | null {
    if (!baseline) return null;
    return {
        capturedAt: baseline.capturedAt,
        fileCount: Object.keys(baseline.files).length,
        csp: baseline.csp !== null,
        source: baseline.source
    };
}

/** Encrypt an error message, or pass `null` straight through. */
export async function encryptError(cipher: SdkCipher, error: string | null): Promise<string | null> {
    return error === null ? null : cipher.encrypt(error);
}

/** Decrypt an error message; an unreadable blob reads as "no detail". */
export async function decryptError(cipher: SdkCipher, blob: string | null): Promise<string | null> {
    return blob === null ? null : cipher.tryDecrypt(blob);
}

/** Ratios and mean latency folded into a service by {@link toService}. */
export interface ServiceStats {
    ratio24h: number | null;
    ratio7d: number | null;
    ratio30d: number | null;
    avgMs24h: number | null;
}

export const EMPTY_STATS: ServiceStats = { ratio24h: null, ratio7d: null, ratio30d: null, avgMs24h: null };

/** Assemble the client DTO from a row, its decrypted target and its stats. */
export async function toService(
    cipher: SdkCipher,
    row: UptimeServiceRow,
    stats: ServiceStats,
    downSince: number | null,
    /** Vrai quand le service vient d'un autre espace qui le projette ici. */
    foreign: boolean,
    planPaused: boolean,
    deploySources: UptimeDeploySource[]
): Promise<UptimeService> {
    const payload = await decryptService(cipher, row.content);
    const integrity = row.integrity_interval_seconds !== null;
    const verdict = integrity ? await decryptVerdict(cipher, row.integrity_verdict) : null;
    return {
        id: row.id,
        name: payload.name,
        url: payload.url,
        integrityIntervalSeconds: row.integrity_interval_seconds,
        paths: payload.paths,
        baseline: integrity ? summarizeBaseline(await decryptBaseline(cipher, row.baseline_enc)) : null,
        integrityCheckedAt: integrity ? row.integrity_checked_at : null,
        integrityDrift: (verdict?.lines.length ?? 0) > 0,
        deployAccept: payload.deployAccept,
        deploySources,
        deployHook: row.deploy_hook_hash !== null,
        method: row.method,
        expectedStatus: row.expected_status,
        keyword: payload.keyword,
        intervalSeconds: row.interval_seconds,
        timeoutSeconds: row.timeout_seconds,
        failureThreshold: row.failure_threshold,
        retentionDays: row.retention_days,
        enabled: row.enabled === 1,
        planPaused,
        sortOrder: row.sort_order,
        foreign,
        status: row.status,
        lastCheckedAt: row.last_checked_at,
        lastResponseMs: row.last_response_ms,
        lastHttpStatus: row.last_http_status,
        lastError: await decryptError(cipher, row.last_error),
        downSince,
        ...stats,
        created: row.created
    };
}

export async function toIncident(cipher: SdkCipher, row: UptimeIncidentRow): Promise<UptimeIncident> {
    return {
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        httpStatus: row.http_status,
        error: await decryptError(cipher, row.error)
    };
}

/** Le chemin d'une page de statut sous l'adresse de DevEye. */
export const STATUS_PATH = '/statut';

/**
 * L'adresse à partager : la racine du domaine choisi une fois vérifié, sinon
 * celle de DevEye. Un domaine en attente n'y paraît pas : le lien ne mènerait
 * nulle part.
 */
export function statusPageUrl(publicOrigin: string, ref: string, domain: SdkDomain | null): string {
    return domain?.verified ? `https://${domain.host}/` : `${publicOrigin}${STATUS_PATH}/${ref}`;
}

/** Partie chiffrée d'une page (`ft_uptime_pages.content`). */
export interface PagePayload {
    title: string;
    description: string;
}

export async function encryptPage(cipher: SdkCipher, payload: PagePayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/** Un blob illisible rend une page sans titre plutôt qu'une erreur : elle reste modifiable. */
export async function decryptPage(cipher: SdkCipher, content: string): Promise<PagePayload> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { title: '', description: '' };
    try {
        const parsed = JSON.parse(plain) as Partial<PagePayload>;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            description: typeof parsed.description === 'string' ? parsed.description : ''
        };
    } catch {
        return { title: '', description: '' };
    }
}

/** Le rendu public, posé par `createService` : ce qu'une écriture doit oublier de son cache. */
let statusPagesRef: { forget(pageId: number): void } | null = null;

export function setStatusPages(pages: { forget(pageId: number): void } | null): void {
    statusPagesRef = pages;
}

/** Sans service (tests), rien n'est en cache : rien à oublier. */
export function forgetStatusPage(pageId: number): void {
    statusPagesRef?.forget(pageId);
}

/**
 * Ce qu'une panne dit d'elle-même en public : une catégorie, jamais le message
 * de la sonde, qui trahirait une adresse du réseau interne ou le mot-clé
 * attendu. Les préfixes sont ceux de `probeService`.
 */
export function publicReason(httpStatus: number | null, error: string | null): string {
    if (error?.startsWith('Délai dépassé')) return 'Délai de réponse dépassé';
    if (error?.startsWith('Mot-clé')) return 'Contenu inattendu';
    // Avant le statut : un écart ou un fichier illisible arrive avec une page en 200.
    if (error?.startsWith('Intégrité')) return 'Intégrité des fichiers compromise';
    if (error?.startsWith('Fichiers')) return 'Fichiers du site indisponibles';
    if (httpStatus !== null) return `Réponse HTTP ${httpStatus}`;
    return 'Connexion impossible';
}
