import type { MailMessage } from '@/Services/mailer';
import { mailHtml } from '@/Services/mailLayout';

type MailBody = Omit<MailMessage, 'to'>;

export function verificationMail(username: string, url: string): MailBody {
    return {
        subject: 'Validez votre adresse pour DevEye',
        text: `Bonjour ${username},

Ouvrez ce lien pour choisir votre mot de passe et créer votre compte DevEye :
${url}

Il est valable 2 h. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucun compte ne sera créé.`,
        html: mailHtml({
            paragraphs: [
                `Bonjour ${username},`,
                'Il ne reste qu’à valider votre adresse et choisir votre mot de passe pour créer votre compte DevEye.'
            ],
            button: { label: 'Valider mon adresse', url },
            footnote:
                'Ce lien est valable 2 h. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : aucun compte ne sera créé.'
        })
    };
}

export function existingAccountMail(loginUrl: string): MailBody {
    return {
        subject: 'Vous avez déjà un compte DevEye',
        text: `Une inscription a été demandée avec cette adresse, qui a déjà un compte DevEye.

Connectez-vous : ${loginUrl}

Si ce n'était pas vous, ignorez ce message : rien n'a changé sur votre compte.`,
        html: mailHtml({
            paragraphs: ['Une inscription a été demandée avec cette adresse, qui a déjà un compte DevEye.'],
            button: { label: 'Se connecter', url: loginUrl },
            footnote: 'Si ce n’était pas vous, ignorez ce message : rien n’a changé sur votre compte.'
        })
    };
}
