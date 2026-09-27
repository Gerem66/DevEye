import type { AudienceSelfEvent } from '@deveye/types/sdk';

/**
 * Ce que le suivi d'usage relève, en noms stables : une page par son chemin
 * statique, une action par sa commande. Jamais un identifiant, un nom ou un
 * texte saisi : Audience agrège des libellés, et ceux-là en créeraient un par
 * élément.
 */

const STATIC_PATH = /^\/[a-z0-9-]+(\/[a-z0-9-]+){0,6}$/;
const PATH_MAX = 120;

/** Un chemin de page montrable : minuscules, chiffres et tirets par segment, sans suite de chiffres qui trahirait un identifiant. */
export function isStaticPath(path: string): boolean {
    return path.length <= PATH_MAX && STATIC_PATH.test(path) && !/\d{3,}/.test(path);
}

const prefixOf = (command: string): string => {
    const i = command.indexOf('.');
    return i === -1 ? command : command.slice(0, i);
};

/** Une commande qui a écrit : son nom, sur la page de sa fonctionnalité. */
export function commandEvent(command: string): AudienceSelfEvent {
    return { type: 'event', name: command, path: `/${prefixOf(command)}` };
}

/** Une commande refusée : son nom et le code du refus, un quota atteint se lit autant qu'une panne. */
export function failureEvent(command: string, code: string): AudienceSelfEvent {
    return { type: 'event', name: `${command} (${code})`, path: `/${prefixOf(command)}` };
}

const AUTH_ROUTES: Record<string, string> = {
    '/api/auth/login': 'auth.login',
    '/api/auth/2fa/challenge': 'auth.twoFactor',
    '/api/auth/logout': 'auth.logout',
    '/api/auth/change-password': 'auth.changePassword',
    '/api/auth/signup': 'auth.signup',
    '/api/auth/signup/verify': 'auth.signupVerify',
    '/api/auth/signup/complete': 'auth.signupComplete'
};

const STATUS_CODE: Record<number, string> = {
    400: 'validation',
    401: 'auth_invalid',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    429: 'rate_limited',
    503: 'maintenance'
};

/** Une route d'authentification, réussie ou refusée ; `null` pour toute autre route. */
export function authEvent(route: string, status: number): AudienceSelfEvent | null {
    const name = AUTH_ROUTES[route];
    if (!name) return null;
    if (status < 400) return { type: 'event', name, path: '/auth' };
    return {
        type: 'event',
        name: `${name} (${STATUS_CODE[status] ?? (status >= 500 ? 'internal' : String(status))})`,
        path: '/auth'
    };
}

/** Ce qui ne compte jamais : le trafic d'un essai, un compte d'essai, et un administrateur quand le réglage l'écarte. */
export function excluded(
    account: { role: string; e2eRun: string | null } | null,
    config: { excludeAdmins: boolean },
    fromRun: boolean
): boolean {
    if (fromRun) return true;
    if (!account) return false;
    return account.e2eRun !== null || (config.excludeAdmins && account.role === 'admin');
}
