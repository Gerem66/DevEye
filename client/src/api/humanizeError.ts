/**
 * Traduit un échec en une phrase courte pour un bandeau d'erreur. Lu sur la
 * forme (`code`, `message`) : une `WsError`, une `ApiError` ou le refus d'une
 * image parlent la même langue.
 */
export function humanizeError(error: unknown, fallback: string): string {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (typeof code !== 'string' || typeof message !== 'string') return fallback;
    // Celui qui refuse a déjà écrit une phrase en français sur ces codes,
    // plus précise que tout ce qu'on pourrait écrire ici.
    if (
        code === 'validation' ||
        code === 'conflict' ||
        code === 'forbidden' ||
        code === 'rate_limited' ||
        code === 'quota_exceeded'
    ) {
        return message || (code === 'forbidden' ? 'Accès refusé.' : fallback);
    }
    if (code === 'not_found') return 'Introuvable: la donnée a peut-être été supprimée entre-temps.';
    if (code === 'locked') return 'Déverrouillage requis.';
    if (code === 'timeout') return 'Délai dépassé.';
    return fallback;
}
