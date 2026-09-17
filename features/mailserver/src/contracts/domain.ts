import { z } from 'zod';

/**
 * La partie locale d'une adresse. Minuscules seulement : le routage compare en
 * minuscules, et deux boîtes qui ne diffèrent que par la casse seraient la
 * même. Le `+` est refusé : il reste libre pour le sous-adressage
 * (`prenom+liste@…` arrive dans la boîte de `prenom`).
 */
export const MAILSERVER_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const MAILSERVER_NAME_MAX = 80;
export const MAILSERVER_QUOTA_MB_MIN = 10;
export const MAILSERVER_QUOTA_MB_MAX = 102_400;
export const MAILSERVER_QUOTA_MB_DEFAULT = 2_048;
export const MAILSERVER_DAILY_LIMIT_MAX = 5_000;
export const MAILSERVER_DAILY_LIMIT_DEFAULT = 200;

export const mailboxSchema = z.object({
    id: z.number().int(),
    /** Vue depuis un autre espace que le sien : elle se lit, elle ne se règle pas. */
    foreign: z.boolean(),
    address: z.string(),
    localPart: z.string(),
    domainId: z.number().int(),
    domainHost: z.string(),
    displayName: z.string(),
    enabled: z.boolean(),
    quotaMb: z.number().int(),
    usedBytes: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    /** Messages sortants par jour glissant. Borne ce que ferait un mot de passe volé. */
    outboundDailyLimit: z.number().int(),
    /** La proposition « lire dans Mails » a été fermée pour de bon. */
    bannerDismissed: z.boolean(),
    lastDeliveryAt: z.number().int().nullable(),
    lastLoginAt: z.number().int().nullable(),
    passwordSetAt: z.number().int(),
    created: z.number().int()
});
export type Mailbox = z.infer<typeof mailboxSchema>;

/** Un mot de passe d'application. Le secret n'est rendu qu'une fois, à la création. */
export const credentialSchema = z.object({
    id: z.number().int(),
    label: z.string(),
    /** `mails` : créé par le bouton « Ajouter à Mails », pour le compte que Mails tient. */
    origin: z.enum(['user', 'mails']),
    created: z.number().int(),
    lastUsedAt: z.number().int().nullable()
});
export type Credential = z.infer<typeof credentialSchema>;

export const mailEventKindSchema = z.enum([
    'received',
    'junked',
    'rejected',
    'sent',
    'deferred',
    'bounced',
    'login',
    'login_failed'
]);
export type MailEventKind = z.infer<typeof mailEventKindSchema>;

/** Le verdict d'une authentification d'expéditeur. `none` : rien à juger. */
export const authVerdictSchema = z.enum(['pass', 'fail', 'none']);
export type AuthVerdict = z.infer<typeof authVerdictSchema>;

/** Un fait daté de la vie d'une boîte. Jamais le sujet ni le corps d'un message. */
export const mailEventSchema = z.object({
    id: z.number().int(),
    ts: z.number().int(),
    kind: mailEventKindSchema,
    size: z.number().int().nonnegative(),
    spf: authVerdictSchema,
    dkim: authVerdictSchema,
    dmarc: authVerdictSchema,
    /** L'autre bout : l'expéditeur d'un reçu, le destinataire d'un envoi, l'IP d'une connexion. */
    peer: z.string(),
    detail: z.string()
});
export type MailEvent = z.infer<typeof mailEventSchema>;

export const dailyPointSchema = z.object({
    /** `AAAA-MM-JJ`, en UTC. */
    day: z.string(),
    received: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    bounced: z.number().int().nonnegative()
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

export const queueStatusSchema = z.enum(['queued', 'sending', 'deferred']);

export const queueEntrySchema = z.object({
    id: z.number().int(),
    mailboxId: z.number().int(),
    from: z.string(),
    rcpt: z.string(),
    status: queueStatusSchema,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int(),
    lastError: z.string(),
    created: z.number().int()
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

export const listenerStateSchema = z.object({
    /** `smtp` (25), `submissions` (465), `submission` (587), `imaps` (993). */
    name: z.enum(['smtp', 'submissions', 'submission', 'imaps']),
    /** Le port annoncé aux clients, pas celui du conteneur. */
    port: z.number().int(),
    up: z.boolean(),
    /** Pourquoi il est fermé, quand il l'est. */
    reason: z.string()
});
export type ListenerState = z.infer<typeof listenerStateSchema>;

export const serverStatusSchema = z.object({
    /** `MAILSERVER_HOSTNAME` est posé : sans lui rien n'écoute. */
    configured: z.boolean(),
    hostname: z.string(),
    listeners: z.array(listenerStateSchema),
    certificate: z
        .object({
            source: z.enum(['acme', 'file']),
            notAfter: z.number().int(),
            /** L'annuaire ACME de staging délivre des certificats que les clients refusent. */
            staging: z.boolean()
        })
        .nullable(),
    certificateError: z.string(),
    queueDepth: z.number().int().nonnegative()
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;

/** Ce qu'un client de messagerie doit saisir pour joindre une boîte. */
export const connectionSchema = z.object({
    host: z.string(),
    imapPort: z.number().int(),
    /** TLS implicite. */
    smtpPort: z.number().int(),
    /** STARTTLS. */
    submissionPort: z.number().int()
});
export type Connection = z.infer<typeof connectionSchema>;

export const activitySchema = z.object({
    daily: z.array(dailyPointSchema),
    totals: z.object({
        received: z.number().int().nonnegative(),
        sent: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        bounced: z.number().int().nonnegative()
    }),
    recent: z.array(mailEventSchema),
    queued: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative()
});
export type Activity = z.infer<typeof activitySchema>;
