import { ws, WsError } from '@/api/ws';
import { ensureUnlocked as ensureSecrecyUnlocked, touchSecrecy } from '@/stores/secrecy';

import type { MailAddress, MailSettings } from 'deveye-types';

/**
 * Run a WS call, and if the server reports the targeted account's encryption
 * as `locked` (a "guarded" account with no live unlock), open the global
 * unlock prompt and retry once. Every command touching account/message/send
 * data goes through this — same discipline as Password/Notes, applied
 * per-account here rather than per-feature.
 */
export async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy();
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            await ensureSecrecyUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

/** Zod's `.flatten()` shape, as attached to a `validation` WsError's `details`. */
function fieldErrorSummary(details: unknown): string | null {
    if (!details || typeof details !== 'object') return null;
    const fieldErrors = (details as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    if (!fieldErrors) return null;
    const parts = Object.entries(fieldErrors)
        .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
        .map(([field, msgs]) => `${field} : ${msgs.join(', ')}`);
    return parts.length > 0 ? parts.join(' · ') : null;
}

export function humanizeError(e: unknown, fallback: string): string {
    if (e instanceof WsError) {
        if (e.code === 'auth_required' || e.code === 'locked') return 'Déverrouillage requis.';
        if (e.code === 'auth_invalid') return 'Identifiants invalides.';
        if (e.code === 'forbidden') return 'Accès refusé.';
        if (e.code === 'not_found') return 'Introuvable.';
        // Anything else: say what actually went wrong. `protocol` in particular
        // is raised client-side by `ws.send` when the payload fails its own
        // schema — swallowing that into a generic sentence left both the user
        // and the logs with nothing to go on.
        const detail = fieldErrorSummary(e.details);
        if (detail) return e.message ? `${e.message} : ${detail}` : detail;
        if (e.message) return e.message;
    }
    return fallback;
}

/**
 * Fills in defaults for any field a `mail.getSettings` response is missing —
 * guards a `mail.setSettings` round-trip against sending back `undefined`
 * (which `JSON.stringify` drops entirely, failing that command's validation)
 * if the server briefly lags behind a newly added settings field.
 */
export function withSettingsDefaults(settings: MailSettings): MailSettings {
    return {
        externalScanEnabledDefault: settings.externalScanEnabledDefault ?? false,
        trustedImageDomains: settings.trustedImageDomains ?? [],
        bodyRenderMode: settings.bodyRenderMode ?? 'embedded'
    };
}

/**
 * Byte count as a short human string. One definition, because three slightly
 * different ones (differing only in decimal places) meant the same attachment
 * read as a different size depending on which surface showed it.
 */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** `Name <address>`, or the bare address when there's no display name. */
export function formatAddress(a: MailAddress): string {
    return a.name ? `${a.name} <${a.address}>` : a.address;
}

export { ws, WsError };
