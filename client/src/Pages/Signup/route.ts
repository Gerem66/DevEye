export type SignupRoute = { kind: 'start'; plan: string | null } | { kind: 'verify'; token: string };

/**
 * `/signup` ouvre l'inscription, `/signup/verify#<jeton>` la termine. Le jeton
 * voyage en fragment : il n'atteint ni le serveur ni les journaux d'un proxy.
 */
export function readSignupRoute(): SignupRoute | null {
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/signup') {
        const plan = new URLSearchParams(window.location.search).get('plan');
        return { kind: 'start', plan: plan && /^[a-z0-9_-]{1,64}$/.test(plan) ? plan : null };
    }
    if (path === '/signup/verify') {
        const m = /^#([A-Za-z0-9_-]+)$/.exec(window.location.hash);
        if (m) return { kind: 'verify', token: m[1] };
    }
    return null;
}
