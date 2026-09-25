import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkPlanPauses } from '@deveye/types/sdk/server';
import { z } from 'zod';

import type { Connection, Mailbox, MailEvent, QueueEntry, ServerStatus } from '../contracts/domain';
import type { EventRow, MailboxRow, MailserverRepo, QueueRow } from './repo';

export type Ctx = SdkFeatureContext<MailserverRepo>;

export const now = (): number => Math.floor(Date.now() / 1000);

/** `AAAA-MM-JJ` en UTC : la clé des compteurs journaliers. */
export const dayOf = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

const MB = 1024 * 1024;
export const bytesOfMb = (mb: number): number => mb * MB;

/** Ce que `content` scelle d'une boîte. */
export const mailboxContentSchema = z.object({ displayName: z.string() });
export type MailboxContent = z.infer<typeof mailboxContentSchema>;

/** Ce que `content` scelle d'une ligne de file. */
export const queueContentSchema = z.object({ from: z.string(), rcpt: z.string(), lastError: z.string() });
export type QueueContent = z.infer<typeof queueContentSchema>;

/** Ce que `content` scelle d'un fait du journal. */
export const eventContentSchema = z.object({ peer: z.string(), detail: z.string() });
export type EventContent = z.infer<typeof eventContentSchema>;

export const seal = (cipher: SdkCipher, value: unknown): Promise<string> => cipher.encrypt(JSON.stringify(value));

/** La limite d'offre qui compte les boîtes : l'hôte en met en pause, les plus récentes d'abord. */
export const ADDRESSES = 'addresses';

/**
 * Une boîte qui sert : allumée, et pas tenue en pause par l'offre. Une boîte en
 * pause est refusée partout exactement comme une éteinte, mêmes codes compris.
 */
export function isServing(mailbox: MailboxRow, pauses: SdkPlanPauses): boolean {
    return mailbox.enabled === 1 && !pauses.isPaused(ADDRESSES, String(mailbox.id));
}

/** Descelle et valide, sans jamais lever : un blob illisible rend le repli. */
export async function unseal<T>(cipher: SdkCipher, blob: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return fallback;
    try {
        return schema.parse(JSON.parse(plain));
    } catch {
        return fallback;
    }
}

export async function toMailbox(
    cipher: SdkCipher,
    row: MailboxRow,
    domainHost: string,
    foreign: boolean,
    pauses: SdkPlanPauses
): Promise<Mailbox> {
    const content = await unseal(cipher, row.content, mailboxContentSchema, { displayName: '' });
    return {
        id: row.id,
        foreign,
        address: row.address,
        localPart: row.local_part,
        domainId: row.domain_id,
        domainHost,
        displayName: content.displayName,
        enabled: row.enabled === 1,
        planPaused: pauses.isPaused(ADDRESSES, String(row.id)),
        quotaMb: Math.round(row.quota_bytes / MB),
        usedBytes: row.used_bytes,
        messageCount: row.message_count,
        outboundDailyLimit: row.outbound_daily_limit,
        bannerDismissed: row.banner_dismissed === 1,
        lastDeliveryAt: row.last_delivery_at,
        lastLoginAt: row.last_login_at,
        passwordSetAt: row.password_set_at,
        created: row.created
    };
}

const VERDICTS = ['none', 'pass', 'fail'] as const;
const verdict = (value: number): (typeof VERDICTS)[number] => VERDICTS[value] ?? 'none';

export async function toEvent(cipher: SdkCipher, row: EventRow): Promise<MailEvent> {
    const content = await unseal(cipher, row.content, eventContentSchema, { peer: '', detail: '' });
    return {
        id: row.id,
        ts: row.ts,
        kind: row.kind as MailEvent['kind'],
        size: row.size,
        spf: verdict(row.spf),
        dkim: verdict(row.dkim),
        dmarc: verdict(row.dmarc),
        peer: content.peer,
        detail: content.detail
    };
}

export async function toQueueEntry(cipher: SdkCipher, row: QueueRow): Promise<QueueEntry> {
    const content = await unseal(cipher, row.content, queueContentSchema, { from: '', rcpt: '', lastError: '' });
    return {
        id: row.id,
        mailboxId: row.mailbox_id,
        from: content.from,
        rcpt: content.rcpt,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastError: content.lastError,
        created: row.created
    };
}

/**
 * Charge une boîte visible de l'espace actif, ou lève `not_found`. Frontière
 * d'espace de la feature : toute commande qui prend un id commence par là.
 */
export async function loadMailbox(ctx: Ctx, id: number, level: 'read' | 'write' = 'read'): Promise<MailboxRow> {
    const row = await ctx.repo.findVisible(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Adresse introuvable.');
    await ctx.items.assert(String(id), level);
    return row;
}

/** Comme {@link loadMailbox}, mais exige le domicile : une fenêtre projetée lit, elle ne règle pas. */
export async function loadHomeMailbox(ctx: Ctx, id: number): Promise<MailboxRow> {
    const row = await loadMailbox(ctx, id, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Cette adresse appartient à un autre espace : elle se règle et se supprime depuis là-bas.'
        );
    }
    return row;
}

/**
 * Ce que les commandes demandent au moteur, qui vit dans le service : il tient
 * des sockets et un certificat, qu'un handler ne voit pas. `null` tant que le
 * service n'a pas démarré.
 */
export interface EngineHandle {
    status(): Promise<ServerStatus>;
    /** `null` sans `MAILSERVER_HOSTNAME`. */
    connection(): Connection | null;
    /** Ferme les sessions ouvertes sur la boîte ; `purge` efface aussi ses fichiers. */
    dropMailbox(mailboxId: number, purge: boolean): Promise<void>;
    /** Une ligne vient d'être relancée : inutile d'attendre le prochain tour. */
    kickQueue(): void;
    /** Rend un corps à la corbeille quand plus rien ne le désigne. */
    releaseBlob(blobId: number): Promise<void>;
}

let engine: EngineHandle | null = null;

export function setEngine(next: EngineHandle | null): void {
    engine = next;
}

export function getEngine(): EngineHandle | null {
    return engine;
}
