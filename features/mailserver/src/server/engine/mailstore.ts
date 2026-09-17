import type { SdkCipher, SdkServerKeys } from '@deveye/types/sdk/server';

import { parseMime, type MimeNode } from '../mime/tree';
import type { BlobRow, FolderRow, MailboxRow, MailserverRepo, MessageRow } from '../repo';
import type { BlobStore } from './blobs';
import type { FolderEvent, Notifier } from './notifier';

/**
 * Les gestes sur les messages, communs à la remise SMTP et aux sessions IMAP :
 * ranger, copier, supprimer, marquer, relire. Chacun tient ensemble la ligne,
 * le corps sur le disque, l'occupation de la boîte et l'annonce aux sessions.
 */

export const FLAG = { Seen: 1, Answered: 2, Flagged: 4, Deleted: 8, Draft: 16 } as const;

/** Ce que `meta` scelle d'un message : de quoi répondre à un FETCH sans relire son corps. */
export interface MessageMeta {
    /** Le bloc d'en-têtes du message, ligne vide comprise, en chaîne d'octets. */
    head: string;
    tree: MimeNode;
}

export class OverQuotaError extends Error {
    constructor() {
        super('Boîte pleine');
    }
}

export interface MailStoreDeps {
    repo: MailserverRepo;
    blobs: BlobStore;
    keys: SdkServerKeys;
    cipherFor(workspaceId: number): SdkCipher;
    notifier: Notifier;
}

export interface AppendOptions {
    flags?: number;
    keywords?: string;
    internalDate: number;
    /** La session à l'origine de l'écriture, qui ne doit pas être prévenue deux fois. */
    except?: (event: FolderEvent) => void;
}

export interface MailStore {
    append(mailbox: MailboxRow, folder: FolderRow, raw: Buffer, options: AppendOptions): Promise<MessageRow>;
    /** Range un corps déjà écrit (une copie, ou la file d'envoi qui remet en local). */
    appendBlob(
        mailbox: MailboxRow,
        folder: FolderRow,
        blob: BlobRow,
        meta: string,
        options: AppendOptions & { size: number }
    ): Promise<MessageRow>;
    copy(mailbox: MailboxRow, message: MessageRow, target: FolderRow): Promise<MessageRow>;
    expunge(mailbox: MailboxRow, message: MessageRow, except?: (event: FolderEvent) => void): Promise<void>;
    setFlags(
        message: MessageRow,
        flags: number,
        keywords: string,
        except?: (event: FolderEvent) => void
    ): Promise<void>;
    readRaw(mailbox: MailboxRow, message: MessageRow): Promise<Buffer>;
    readMeta(mailbox: MailboxRow, message: MessageRow): Promise<MessageMeta>;
    /** Écrit un corps sans le ranger nulle part : la file d'envoi le tient par sa référence. */
    writeBlob(mailbox: MailboxRow, raw: Buffer): Promise<BlobRow>;
    readBlob(mailbox: MailboxRow, blobId: number): Promise<Buffer>;
    /** Une référence de moins ; à zéro, la ligne et le fichier partent. */
    releaseBlob(blobId: number): Promise<void>;
    sealMeta(mailbox: MailboxRow, raw: Buffer): Promise<string>;
    /** Vide un dossier puis le retire. */
    deleteFolder(mailbox: MailboxRow, folder: FolderRow): Promise<void>;
    purgeMailbox(mailboxId: number): Promise<void>;
}

/** Quelques corps déchiffrés restent sous la main : un client lit souvent plusieurs sections du même message. */
const RAW_CACHE_ENTRIES = 8;

export function createMailStore(deps: MailStoreDeps): MailStore {
    const { repo, blobs, notifier } = deps;
    const keyCache = new Map<number, Buffer>();
    const rawCache = new Map<number, Buffer>();

    function blobKey(mailbox: MailboxRow): Buffer {
        let key = keyCache.get(mailbox.id);
        if (!key) {
            const opened = deps.keys.openBytes(mailbox.blob_key);
            if (opened === null) throw new Error(`Clé de la boîte ${mailbox.id} illisible`);
            key = Buffer.from(opened);
            keyCache.set(mailbox.id, key);
        }
        return key;
    }

    async function assertRoom(mailboxId: number, size: number): Promise<void> {
        // Relue à chaque fois : l'occupation bouge entre deux remises.
        const fresh = await repo.findById(mailboxId);
        if (!fresh || fresh.used_bytes + size > fresh.quota_bytes) throw new OverQuotaError();
    }

    async function sealMeta(mailbox: MailboxRow, raw: Buffer): Promise<string> {
        const tree = parseMime(raw);
        const meta: MessageMeta = { head: raw.subarray(0, tree.bodyStart).toString('latin1'), tree };
        return deps.cipherFor(mailbox.workspace_id).encrypt(JSON.stringify(meta));
    }

    async function writeBlob(mailbox: MailboxRow, raw: Buffer): Promise<BlobRow> {
        const ref = await blobs.write(mailbox.id, blobKey(mailbox), raw);
        const id = await repo.createBlob({ mailboxId: mailbox.id, ref, size: raw.length });
        return { id, mailbox_id: mailbox.id, ref, size: raw.length, refs: 1 };
    }

    async function releaseBlob(blobId: number): Promise<void> {
        const blob = await repo.findBlob(blobId);
        if (!blob) return;
        if ((await repo.refBlob(blobId, -1)) > 0) return;
        await repo.deleteBlob(blobId);
        await blobs.remove(blob.mailbox_id, blob.ref);
        rawCache.delete(blobId);
    }

    async function appendBlob(
        mailbox: MailboxRow,
        folder: FolderRow,
        blob: BlobRow,
        meta: string,
        options: AppendOptions & { size: number }
    ): Promise<MessageRow> {
        const uid = await repo.allocateUid(folder.id);
        const row = {
            mailboxId: mailbox.id,
            folderId: folder.id,
            uid,
            flags: options.flags ?? 0,
            keywords: options.keywords ?? '',
            internalDate: options.internalDate,
            size: options.size,
            blobId: blob.id,
            meta
        };
        const id = await repo.insertMessage(row);
        await repo.adjustUsage(mailbox.id, options.size, 1);
        const message: MessageRow = {
            id,
            mailbox_id: mailbox.id,
            folder_id: folder.id,
            uid,
            flags: row.flags,
            keywords: row.keywords,
            internal_date: row.internalDate,
            size: row.size,
            blob_id: blob.id
        };
        notifier.emit(folder.id, { type: 'exists', message }, options.except);
        return message;
    }

    async function readBlob(mailbox: MailboxRow, blobId: number): Promise<Buffer> {
        const cached = rawCache.get(blobId);
        if (cached) return cached;
        const blob = await repo.findBlob(blobId);
        if (!blob) throw new Error('Corps du message introuvable');
        const raw = await blobs.read(mailbox.id, blobKey(mailbox), blob.ref);
        rawCache.set(blobId, raw);
        if (rawCache.size > RAW_CACHE_ENTRIES) {
            const oldest = rawCache.keys().next().value;
            if (oldest !== undefined) rawCache.delete(oldest);
        }
        return raw;
    }

    async function expunge(
        mailbox: MailboxRow,
        message: MessageRow,
        except?: (event: FolderEvent) => void
    ): Promise<void> {
        await repo.deleteMessage(message.id);
        await repo.adjustUsage(mailbox.id, -message.size, -1);
        await releaseBlob(message.blob_id);
        notifier.emit(message.folder_id, { type: 'expunge', uid: message.uid }, except);
    }

    return {
        async append(mailbox, folder, raw, options) {
            await assertRoom(mailbox.id, raw.length);
            const meta = await sealMeta(mailbox, raw);
            const blob = await writeBlob(mailbox, raw);
            return appendBlob(mailbox, folder, blob, meta, { ...options, size: raw.length });
        },

        appendBlob,

        async copy(mailbox, message, target) {
            await assertRoom(mailbox.id, message.size);
            const [blob, meta] = await Promise.all([repo.findBlob(message.blob_id), repo.messageMeta(message.id)]);
            if (!blob || meta === null) throw new Error('Message disparu pendant la copie');
            // Le corps est partagé, pas dupliqué : une référence de plus sur le même fichier.
            await repo.refBlob(blob.id, 1);
            return appendBlob(mailbox, target, blob, meta, {
                flags: message.flags,
                keywords: message.keywords,
                internalDate: message.internal_date,
                size: message.size
            });
        },

        expunge,

        async setFlags(message, flags, keywords, except) {
            await repo.setFlags(message.id, flags, keywords);
            notifier.emit(message.folder_id, { type: 'flags', uid: message.uid, flags, keywords }, except);
        },

        readRaw: (mailbox, message) => readBlob(mailbox, message.blob_id),
        readBlob,

        async readMeta(mailbox, message) {
            const sealed = await repo.messageMeta(message.id);
            if (sealed === null) throw new Error('Message introuvable');
            return JSON.parse(await deps.cipherFor(mailbox.workspace_id).decrypt(sealed)) as MessageMeta;
        },

        writeBlob,
        releaseBlob,
        sealMeta,

        async deleteFolder(mailbox, folder) {
            for (const message of await repo.listMessages(folder.id)) await expunge(mailbox, message);
            await repo.deleteFolder(folder.id);
        },

        async purgeMailbox(mailboxId) {
            keyCache.delete(mailboxId);
            await blobs.purge(mailboxId);
        }
    };
}
