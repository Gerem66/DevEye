import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
    html: string;
}

export interface Mailer {
    /** Faux sans `SMTP_HOST` : à l'appelant de dire quoi faire à la place. */
    readonly configured: boolean;
    send(message: MailMessage): Promise<void>;
    /** La poignée de main avec le serveur SMTP, sans rien envoyer. */
    verify(): Promise<void>;
}

export interface MailerConfig {
    host?: string;
    port: number;
    user?: string;
    password?: string;
    from?: string;
}

/** 465 = TLS implicite, tout autre port = STARTTLS exigé. */
export function transportOptions(config: MailerConfig) {
    const implicitTls = config.port === 465;
    return {
        host: config.host,
        port: config.port,
        secure: implicitTls,
        requireTLS: implicitTls ? undefined : true,
        auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined
    };
}

/** Les mails que le serveur envoie en son nom, hors de tout espace. */
export function createMailer(config: MailerConfig): Mailer {
    let transport: Transporter | null = null;
    const open = (): Transporter => {
        if (!config.host) throw new Error('SMTP non configuré');
        transport ??= nodemailer.createTransport(transportOptions(config));
        return transport;
    };
    return {
        configured: Boolean(config.host),
        async send({ to, subject, text, html }) {
            await open().sendMail({ from: config.from, to, subject, text, html });
        },
        async verify() {
            await open().verify();
        }
    };
}
