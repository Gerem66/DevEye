import type { SdkAccountMailMessage } from '@deveye/types/sdk/server';

export function verificationMail(username: string, url: string): SdkAccountMailMessage {
    return {
        subject: 'Validez votre adresse pour DevEye',
        paragraphs: [
            `Bonjour ${username},`,
            'Il ne reste qu’à valider votre adresse et choisir votre mot de passe pour créer votre compte DevEye.'
        ],
        button: { label: 'Valider mon adresse', url },
        footnote:
            'Ce lien est valable 2 h. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : aucun compte ne sera créé.'
    };
}

export function existingAccountMail(loginUrl: string): SdkAccountMailMessage {
    return {
        subject: 'Vous avez déjà un compte DevEye',
        paragraphs: ['Une inscription a été demandée avec cette adresse, qui a déjà un compte DevEye.'],
        button: { label: 'Se connecter', url: loginUrl },
        footnote: 'Si ce n’était pas vous, ignorez ce message : rien n’a changé sur votre compte.'
    };
}
