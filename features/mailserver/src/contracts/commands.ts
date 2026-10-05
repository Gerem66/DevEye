import { z } from 'zod';

import {
    MAILSERVER_DAILY_LIMIT_MAX,
    MAILSERVER_NAME_MAX,
    MAILSERVER_QUOTA_MB_MAX,
    MAILSERVER_QUOTA_MB_MIN,
    activitySchema,
    connectionSchema,
    credentialSchema,
    mailboxSchema,
    queueEntrySchema,
    serverStatusSchema
} from './domain';

const id = z.number().int().positive();
const ok = z.object({ ok: z.literal(true) });
const quotaMb = z.number().int().min(MAILSERVER_QUOTA_MB_MIN).max(MAILSERVER_QUOTA_MB_MAX);

export const mailserverCount = {
    command: 'mailserver.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative(), lastDeliveryAt: z.number().int().nullable() })
};

export const mailserverList = {
    command: 'mailserver.list' as const,
    input: z.object({}),
    output: z.object({ mailboxes: z.array(mailboxSchema) })
};

export const mailserverGet = {
    command: 'mailserver.get' as const,
    input: z.object({ id }),
    output: z.object({ mailbox: mailboxSchema, connection: connectionSchema.nullable() })
};

/** Le mot de passe n'est rendu qu'ici : il n'est conservé que haché. */
export const mailserverCreate = {
    command: 'mailserver.create' as const,
    input: z.object({
        localPart: z.string().min(1).max(64),
        domainId: id,
        displayName: z.string().max(MAILSERVER_NAME_MAX),
        quotaMb
    }),
    output: z.object({ mailbox: mailboxSchema, password: z.string() })
};

/** L'adresse ne change pas : ce serait une autre boîte pour tous ses correspondants. */
export const mailserverUpdate = {
    command: 'mailserver.update' as const,
    input: z.object({
        id,
        displayName: z.string().max(MAILSERVER_NAME_MAX),
        quotaMb,
        enabled: z.boolean(),
        outboundDailyLimit: z.number().int().min(0).max(MAILSERVER_DAILY_LIMIT_MAX)
    }),
    output: z.object({ mailbox: mailboxSchema })
};

export const mailserverDelete = { command: 'mailserver.delete' as const, input: z.object({ id }), output: ok };

export const mailserverSetBanner = {
    command: 'mailserver.setBanner' as const,
    input: z.object({ id, dismissed: z.boolean() }),
    output: z.object({ mailbox: mailboxSchema })
};

export const mailserverPasswordReset = {
    command: 'mailserver.passwordReset' as const,
    input: z.object({ id }),
    output: z.object({ password: z.string() })
};

export const mailserverAppPasswordList = {
    command: 'mailserver.appPasswordList' as const,
    input: z.object({ id }),
    output: z.object({ credentials: z.array(credentialSchema) })
};

export const mailserverAppPasswordCreate = {
    command: 'mailserver.appPasswordCreate' as const,
    input: z.object({
        id,
        label: z.string().min(1).max(MAILSERVER_NAME_MAX),
        /** Pour le compte que Mail va tenir : le serveur range alors lui-même une copie des envois. */
        forMails: z.boolean().default(false)
    }),
    output: z.object({ credential: credentialSchema, secret: z.string() })
};

export const mailserverAppPasswordRevoke = {
    command: 'mailserver.appPasswordRevoke' as const,
    input: z.object({ id, credentialId: id }),
    output: ok
};

export const mailserverActivity = {
    command: 'mailserver.activity' as const,
    input: z.object({ id, days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }),
    output: activitySchema
};

export const mailserverQueueList = {
    command: 'mailserver.queueList' as const,
    input: z.object({ id: id.optional() }),
    output: z.object({ entries: z.array(queueEntrySchema) })
};

export const mailserverQueueRetry = {
    command: 'mailserver.queueRetry' as const,
    input: z.object({ queueId: id }),
    output: ok
};

export const mailserverQueueDrop = {
    command: 'mailserver.queueDrop' as const,
    input: z.object({ queueId: id }),
    output: ok
};

export const mailserverServerStatus = {
    command: 'mailserver.serverStatus' as const,
    input: z.object({}),
    output: z.object({ status: serverStatusSchema, connection: connectionSchema.nullable() })
};

export const mailserverCommands = [
    mailserverCount,
    mailserverList,
    mailserverGet,
    mailserverCreate,
    mailserverUpdate,
    mailserverDelete,
    mailserverSetBanner,
    mailserverPasswordReset,
    mailserverAppPasswordList,
    mailserverAppPasswordCreate,
    mailserverAppPasswordRevoke,
    mailserverActivity,
    mailserverQueueList,
    mailserverQueueRetry,
    mailserverQueueDrop,
    mailserverServerStatus
] as const;
