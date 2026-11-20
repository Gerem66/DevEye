import type { SdkAccountMailMessage } from '@deveye/types/sdk/server';

export function passwordResetMail(username: string, url: string, recoveryRequired: boolean): SdkAccountMailMessage {
    return {
        subject: 'Réinitialiser votre mot de passe DevEye',
        paragraphs: [
            `Bonjour ${username},`,
            'Une réinitialisation du mot de passe de votre compte DevEye a été demandée. Choisissez-en un nouveau avec le bouton ci-dessous.',
            `Pour rappel, votre nom d’utilisateur, celui qui sert à vous connecter, est « ${username} ».`
        ],
        ...(recoveryRequired
            ? {
                  notice: 'Vos données sont chiffrées par votre mot de passe : la page vous demandera aussi le code de récupération remis à l’activation du chiffrement. Sans lui, le mot de passe ne peut pas être réinitialisé.'
              }
            : {}),
        button: { label: 'Choisir un nouveau mot de passe', url },
        footnote:
            'Ce lien est valable 1 h et ne sert qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe ne change pas.'
    };
}

/** Le compte chiffré sans code de récupération : seul son mot de passe actuel rouvre ses données. */
export function passwordResetImpossibleMail(username: string, loginUrl: string): SdkAccountMailMessage {
    return {
        subject: 'Votre mot de passe DevEye ne peut pas être réinitialisé',
        paragraphs: [
            `Bonjour ${username},`,
            'Une réinitialisation du mot de passe de votre compte DevEye a été demandée.',
            'Vos données sont chiffrées par votre mot de passe, et aucun code de récupération n’a été choisi à l’activation du chiffrement : sans ce mot de passe, personne ne peut les déchiffrer, pas même le service. Il ne peut donc pas être réinitialisé.',
            'Votre mot de passe actuel, lui, n’a pas changé : s’il vous revient, connectez-vous simplement avec, puis créez un code de récupération dans les réglages Sécurité.',
            `Pour rappel, votre nom d’utilisateur, celui qui sert à vous connecter, est « ${username} ».`
        ],
        button: { label: 'Se connecter', url: loginUrl },
        footnote:
            'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : rien n’a changé sur votre compte.'
    };
}
