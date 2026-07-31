import nodemailer, { type Transporter } from 'nodemailer';

import { logger } from '@/logger';
import { env } from '@/Utils/Env';

/**
 * Outgoing mail, built once from the SMTP_* environment.
 *
 * Entirely optional: with no `SMTP_HOST` the app runs exactly as before and
 * {@link isMailerReady} is false, so callers surface "no mail configured"
 * instead of silently dropping messages.
 */

export interface MailMessage {
    to: string;
    subject: string;
    /** Plain-text body — the only format sent, so no HTML escaping to get wrong. */
    text: string;
}

let transporter: Transporter | null = null;

/** True when the server can actually send mail. */
export function isMailerReady(): boolean {
    return Boolean(env.SMTP_HOST);
}

/** The `From:` address: explicit when set, else the SMTP account itself. */
function sender(): string {
    return env.SMTP_FROM || env.SMTP_USERNAME || 'deveye@localhost';
}

function getTransporter(): Transporter {
    transporter ??= nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USERNAME ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD ?? '' } : undefined
    });
    return transporter;
}

/**
 * Send one message. Rejects with a human-readable reason rather than a raw SMTP
 * error object, so callers can put it straight in front of the user.
 */
export async function sendMail(message: MailMessage): Promise<void> {
    if (!isMailerReady()) throw new Error("Aucun serveur SMTP n'est configuré sur le serveur");
    try {
        await getTransporter().sendMail({ from: sender(), ...message });
        logger.debug({ to: message.to, subject: message.subject }, 'Mail sent');
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error({ to: message.to, err: reason }, 'Mail delivery failed');
        throw new Error(`Envoi du mail impossible : ${reason}`);
    }
}
