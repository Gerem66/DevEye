import type { MailMessage } from '@/Services/mailer';

type MailBody = Omit<MailMessage, 'to'>;

// Un mail ne lit aucune feuille de style : les teintes du thème sont recopiées
// ici, et nulle part ailleurs côté serveur.
const ACCENT = '#22d3ee';
const ON_ACCENT = '#05222a';
const TEXT = '#1b2430';
const MUTED = '#5b6672';

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function layout(paragraphs: string[], button: { label: string; url: string }, footnote: string): string {
    const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
    return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:${TEXT};max-width:480px;margin:0 auto;padding:24px">
<p style="margin:0 0 24px;font-size:20px"><b>Dev</b>Eye</p>
${body}
<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${ACCENT};color:${ON_ACCENT};font-weight:600;text-decoration:none">${button.label}</a></p>
<p style="margin:0;font-size:13px;color:${MUTED}">${footnote}</p>
</div>`;
}

export function verificationMail(username: string, url: string): MailBody {
    const name = escapeHtml(username);
    return {
        subject: 'Validez votre adresse pour DevEye',
        text: `Bonjour ${username},

Ouvrez ce lien pour choisir votre mot de passe et créer votre compte DevEye :
${url}

Il est valable 2 h. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucun compte ne sera créé.`,
        html: layout(
            [
                `Bonjour ${name},`,
                'Il ne reste qu’à valider votre adresse et choisir votre mot de passe pour créer votre compte DevEye.'
            ],
            { label: 'Valider mon adresse', url },
            'Ce lien est valable 2 h. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : aucun compte ne sera créé.'
        )
    };
}

export function existingAccountMail(loginUrl: string): MailBody {
    return {
        subject: 'Vous avez déjà un compte DevEye',
        text: `Une inscription a été demandée avec cette adresse, qui a déjà un compte DevEye.

Connectez-vous : ${loginUrl}

Si ce n'était pas vous, ignorez ce message : rien n'a changé sur votre compte.`,
        html: layout(
            ['Une inscription a été demandée avec cette adresse, qui a déjà un compte DevEye.'],
            { label: 'Se connecter', url: loginUrl },
            'Si ce n’était pas vous, ignorez ce message : rien n’a changé sur votre compte.'
        )
    };
}
