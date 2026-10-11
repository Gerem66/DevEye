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

export interface AccountExportedFacts {
    username: string;
    /** Secondes. */
    at: number;
    /** Le site vitrine, où vivent les pages légales ; `null` sans site. */
    site: string | null;
}

/** L'archive porte le coffre en clair : le titulaire doit savoir qu'elle existe, où qu'elle ait été téléchargée. */
export function accountExportedMail({ username, at, site }: AccountExportedFacts): SdkAccountMailMessage {
    const moment = new Date(at * 1000).toLocaleString('fr-FR', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'Europe/Paris'
    });
    return {
        subject: 'Vos données DevEye ont été exportées',
        paragraphs: [
            `Bonjour ${username},`,
            `L’export de toutes les données de votre compte a été téléchargé le ${moment}, depuis une session ouverte avec votre mot de passe.`,
            'Cette archive contient vos données en clair, y compris votre coffre de mots de passe et vos notes privées. Gardez-la en lieu sûr, et supprimez-la quand vous n’en avez plus besoin.'
        ],
        notice: 'Si vous n’êtes pas à l’origine de cet export, changez votre mot de passe tout de suite : cela ferme toutes vos sessions.',
        ...(site ? { footnote: `Pour toute question, nos coordonnées sont sur ${site}/mentions-legales` } : {})
    };
}

export interface LoginCodeFacts {
    username: string;
    code: string;
    /** Le navigateur qui se connecte, tel que son User-Agent le décrit. */
    browser: string;
    ip: string;
    /** Secondes. */
    at: number;
}

/**
 * Le code d'une connexion depuis un navigateur que le compte ne connaît pas.
 * Il part dès le mot de passe validé : même si la 2FA arrête l'intrus, le
 * titulaire apprend que son mot de passe est connu.
 */
export function loginCodeMail({ username, code, browser, ip, at }: LoginCodeFacts): SdkAccountMailMessage {
    const moment = new Date(at * 1000).toLocaleString('fr-FR', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'Europe/Paris'
    });
    return {
        subject: 'Votre code de connexion à DevEye',
        paragraphs: [
            `Bonjour ${username},`,
            `Une connexion à votre compte attend ce code, depuis un navigateur que DevEye ne connaît pas encore : ${browser}, adresse IP ${ip}, le ${moment}.`,
            'Saisissez-le sur la page de connexion. Il expire dans 10 minutes.'
        ],
        notice: `Votre code : ${code}`,
        footnote:
            'Si ce n’est pas vous, quelqu’un connaît votre mot de passe : changez-le depuis votre profil, cela ferme toutes vos sessions. Ne communiquez jamais ce code, DevEye ne vous le demandera pas.'
    };
}
