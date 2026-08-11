import type { BadgeTone } from '@/Components/StatusBadge';
import type { MailAccount } from 'deveye-types';

/**
 * Comment se dit l'état d'une boîte, au même endroit pour les deux surfaces qui
 * l'affichent : la pastille d'une carte et le bandeau de la boîte ouverte.
 *
 * Les libellés parlent de ce qu'il y a à faire, pas de ce qui a techniquement
 * échoué — le message brut du serveur reste disponible juste à côté, et il est
 * le seul à pouvoir être précis.
 */
export interface AccountStatusView {
    tone: BadgeTone;
    /** Deux mots, pour la pastille d'une carte. */
    badge: string;
    /** Une phrase, pour le bandeau : ce qui se passe et ce qu'on peut y faire. */
    headline: string;
}

/**
 * `null` quand il n'y a rien à signaler — l'appelant n'affiche alors rien du
 * tout, plutôt qu'une pastille verte permanente : une boîte qui marche est le
 * cas normal, et le dire en continu ne ferait que diluer les cas qui comptent.
 *
 * `needsReauth` passe devant l'état de la dernière opération : il décrit une
 * impasse déjà certaine (plus de jeton de rafraîchissement), là où `auth` peut
 * n'être qu'un mot de passe changé.
 */
export function describeAccountStatus(account: MailAccount): AccountStatusView | null {
    if (account.needsReauth) {
        return {
            tone: 'danger',
            badge: 'reconnexion requise',
            headline: 'La connexion à ce compte a expiré : reconnectez-le pour retrouver vos messages.'
        };
    }
    switch (account.status) {
        case 'auth':
            return {
                tone: 'danger',
                badge: 'accès refusé',
                headline:
                    'Le serveur de mail a refusé l’accès à cette boîte. Vérifiez les identifiants, ou reconnectez le compte si son autorisation a été retirée.'
            };
        case 'unreachable':
            return {
                tone: 'warning',
                badge: 'injoignable',
                headline:
                    'Ce serveur de mail ne répond pas. La relève reprendra d’elle-même dès qu’il sera de nouveau joignable.'
            };
        case 'error':
            return {
                tone: 'warning',
                badge: 'erreur',
                headline: 'La dernière opération sur cette boîte a échoué.'
            };
        case 'ok':
            return null;
    }
}
