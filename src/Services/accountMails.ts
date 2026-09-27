import type { SdkAccountMailMessage } from '@deveye/types/sdk/server';

export interface AccountDeletedFacts {
    username: string;
    /** Le titulaire lui-même, ou l'administration du service. */
    by: 'self' | 'admin';
    /** Secondes. */
    at: number;
    /** Ce que les modules ont à dire (un abonnement résilié), un paragraphe chacun. */
    notes: readonly string[];
    /** Le site vitrine, où vivent les pages légales ; `null` sans site. */
    site: string | null;
}

export function accountDeletedMail({ username, by, at, notes, site }: AccountDeletedFacts): SdkAccountMailMessage {
    const moment = new Date(at * 1000).toLocaleString('fr-FR', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'Europe/Paris'
    });
    return {
        subject: 'Votre compte DevEye a été supprimé',
        paragraphs: [
            `Bonjour ${username},`,
            by === 'self'
                ? `Comme vous l’avez demandé, votre compte DevEye a été supprimé le ${moment}.`
                : `Votre compte DevEye a été supprimé le ${moment} par l’administration du service.`,
            'Votre espace personnel, les espaces partagés dont vous étiez propriétaire et tout ce qu’ils contenaient ont été effacés avec lui, sans délai de reprise. Les espaces partagés dont vous n’étiez que membre continuent sans vous.',
            ...notes
        ],
        footnote: [
            'Les sauvegardes du service en gardent une copie jusqu’à leur renouvellement suivant, trente jours au plus.',
            ...(site ? [`Pour toute question, nos coordonnées sont sur ${site}/mentions-legales`] : [])
        ].join(' ')
    };
}
