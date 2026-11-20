export type PasswordResetRoute = { kind: 'forgot' } | { kind: 'reset'; token: string };

/**
 * `/forgot-password` demande le lien, `/reset-password#<jeton>` l'ouvre. Le
 * jeton voyage en fragment : il n'atteint ni le serveur ni les journaux d'un proxy.
 */
export function readPasswordResetRoute(): PasswordResetRoute | null {
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/forgot-password') return { kind: 'forgot' };
    if (path === '/reset-password') {
        const m = /^#([A-Za-z0-9_-]+)$/.exec(window.location.hash);
        if (m) return { kind: 'reset', token: m[1] };
    }
    return null;
}
