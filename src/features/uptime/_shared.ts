import type { UptimeIncident, UptimeIncidentRow, UptimeService, UptimeServiceRow } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';

/**
 * Encrypted part of a service (stored as `uptime_services.content`). Everything
 * else lives in clear columns so the scheduler can plan probes and the charts
 * can aggregate without decrypting a thing.
 */
export interface ServicePayload {
    name: string;
    url: string;
    keyword: string | null;
}

export async function encryptService(cipher: Cipher, payload: ServicePayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * Decode a service's target. Falls back to blanks rather than throwing: a row
 * whose blob can't be read must still be listable (and deletable) instead of
 * breaking the whole feature.
 */
export async function decryptService(cipher: Cipher, content: string): Promise<ServicePayload> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { name: '', url: '', keyword: null };
    try {
        const parsed = JSON.parse(plain) as Partial<ServicePayload>;
        return {
            name: typeof parsed.name === 'string' ? parsed.name : '',
            url: typeof parsed.url === 'string' ? parsed.url : '',
            keyword: typeof parsed.keyword === 'string' ? parsed.keyword : null
        };
    } catch {
        return { name: '', url: '', keyword: null };
    }
}

/** Encrypt an error message, or pass `null` straight through. */
export async function encryptError(cipher: Cipher, error: string | null): Promise<string | null> {
    return error === null ? null : cipher.encrypt(error);
}

/** Decrypt an error message; an unreadable blob reads as "no detail". */
export async function decryptError(cipher: Cipher, blob: string | null): Promise<string | null> {
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
    cipher: Cipher,
    row: UptimeServiceRow,
    stats: ServiceStats,
    downSince: number | null,
    /** Vrai quand le service vient d'un autre espace qui le projette ici. */
    foreign = false
): Promise<UptimeService> {
    const payload = await decryptService(cipher, row.content);
    return {
        id: row.id,
        name: payload.name,
        url: payload.url,
        method: row.method,
        expectedStatus: row.expected_status,
        keyword: payload.keyword,
        intervalSeconds: row.interval_seconds,
        timeoutSeconds: row.timeout_seconds,
        failureThreshold: row.failure_threshold,
        retentionDays: row.retention_days,
        notify: row.notify === 1,
        enabled: row.enabled === 1,
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

export async function toIncident(cipher: Cipher, row: UptimeIncidentRow): Promise<UptimeIncident> {
    return {
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        httpStatus: row.http_status,
        error: await decryptError(cipher, row.error)
    };
}
