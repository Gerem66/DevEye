import { featureApi, WsError } from 'deveye-sdk-client';

import { manifest } from '../manifest';

import type { MailAddress, MailSettings } from '../contracts/domain';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

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

/**
 * La traduction des erreurs de Mail, plus large que le `humanizeError` du
 * barrel : elle connaît les deux codes d'authentification d'une boîte
 * (`auth_required`, `auth_invalid`), déplie les détails de validation par
 * champ, et laisse passer le message de tout autre code. Le barrel fournit
 * `WsError` ; la lecture des codes reste celle de la feature.
 */
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

/** `Name <address>`, or the bare address when there's no display name. */
export function formatAddress(a: MailAddress): string {
    return a.name ? `${a.name} <${a.address}>` : a.address;
}
