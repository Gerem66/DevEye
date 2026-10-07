import { ApiError } from '@/api/http';

export function humanizeSignupError(e: unknown): string {
    if (!(e instanceof ApiError)) return 'Erreur inconnue';
    switch (e.code) {
        case 'validation':
            return 'Vérifiez les informations saisies';
        case 'rate_limited':
            return 'Trop de tentatives, réessayez plus tard';
        case 'network':
            return 'Serveur injoignable';
        default:
            return e.message || 'Erreur inconnue';
    }
}

/** Le champ que désigne un refus du serveur : seul un nom déjà pris en désigne un. */
export function signupErrorField(e: unknown): 'username' | null {
    return e instanceof ApiError && e.code === 'conflict' ? 'username' : null;
}
