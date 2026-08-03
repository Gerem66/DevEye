import type { MailAccountRow, MailFolderRow } from 'deveye-types';
import * as mailClient from '@/Services/MailAccountClient';
import type { Cipher } from '@/Services/SecureStore';
import type { Database } from '@/db';
import { encryptEnvelope, persistRefreshedToken } from './_shared';

/**
 * Sync logic shared between the on-demand `mail.folderList`/`mail.folderSync`
 * commands (live WS session) and {@link MailSyncService}'s background tick for
 * "open"-tier accounts (no session). Both sides already hold the right cipher
 * for the account's tier and its decrypted credentials — this module only
 * talks to IMAP and writes the metadata cache, nothing about auth/gating.
 */

/** First-sync cap: how many of a folder's most recent messages to backfill. */
export const INITIAL_SYNC_LIMIT = 200;

/** Cache one folder's worth of fetched envelopes — identical for a forward sync, a backfill and a remote search. */
export async function cacheEnvelopes(
    db: Database,
    cipher: Cipher,
    folderId: number,
    messages: mailClient.RemoteEnvelope[]
): Promise<void> {
    for (const msg of messages) {
        await db.mailMessages.upsertEnvelope({
            folderId,
            uid: msg.uid,
            // Snippet needs the body, which is never fetched during a sync and
            // never stored — it stays empty by design (see `039_mail.sql`).
            envelopeEnc: await encryptEnvelope(cipher, {
                subject: msg.subject,
                from: msg.from,
                to: msg.to,
                snippet: ''
            }),
            date: msg.date,
            seen: msg.seen,
            flagged: msg.flagged,
            answered: msg.answered,
            hasAttachments: msg.hasAttachments
        });
    }
}

/**
 * Recompute a folder's cached counts and low-water mark after rows were added
 * outside a forward sync — a backfill or a remote search, both of which write
 * *older* messages into the cache and so can only move `first_seen_uid` down.
 * `last_seen_uid`/`uid_validity` are deliberately carried through untouched:
 * neither operation learns anything new about the top of the mailbox.
 */
export async function refreshFolderCounts(db: Database, folder: MailFolderRow): Promise<void> {
    const counts = await db.mailMessages.countByFolder(folder.id);
    await db.mailFolders.updateCounts(folder.id, {
        uidValidity: folder.uid_validity,
        lastSeenUid: folder.last_seen_uid,
        firstSeenUid: await db.mailMessages.minUidByFolder(folder.id),
        unreadCount: counts.unseen,
        totalCount: counts.total
    });
}

/** Refresh the folder list from IMAP and upsert it into `mail_folders`. */
export async function syncAccountFolders(
    db: Database,
    cipher: Cipher,
    account: MailAccountRow,
    credentials: mailClient.MailCredentials
): Promise<MailFolderRow[]> {
    const remote = await mailClient.listFolders(
        credentials,
        persistRefreshedToken(db, account.id, credentials, cipher)
    );
    for (const folder of remote) {
        await db.mailFolders.upsert({
            accountId: account.id,
            imapPath: folder.imapPath,
            nameEnc: await cipher.encrypt(folder.name),
            specialUse: folder.specialUse,
            uidValidity: null
        });
    }
    return db.mailFolders.listByAccount(account.id);
}

/**
 * Pull new envelopes for one folder and refresh its counts. Detects a
 * `UIDVALIDITY` change (mailbox recreated server-side) by re-checking after
 * the first fetch and, if it moved, drops the stale cache and re-fetches
 * fresh — a folder never ends up mixing two UID spaces.
 */
export async function syncOneFolder(
    db: Database,
    cipher: Cipher,
    account: MailAccountRow,
    credentials: mailClient.MailCredentials,
    folder: MailFolderRow,
    /** Message-level progress within this one folder — see `MailSyncService`/`_syncStatus`. */
    onProgress?: (done: number, estimatedTotal: number) => void
): Promise<{ newCount: number }> {
    const refresh = persistRefreshedToken(db, account.id, credentials, cipher);
    let sinceUid = folder.last_seen_uid;
    let result = await mailClient.syncFolder(
        credentials,
        folder.imap_path,
        sinceUid,
        INITIAL_SYNC_LIMIT,
        refresh,
        onProgress
    );

    const validityKnown = folder.uid_validity !== null;
    if (validityKnown && folder.uid_validity !== result.uidValidity) {
        // The mailbox was recreated: our cached UIDs no longer mean anything.
        await db.mailMessages.deleteByFolder(folder.id);
        sinceUid = null;
        result = await mailClient.syncFolder(
            credentials,
            folder.imap_path,
            sinceUid,
            INITIAL_SYNC_LIMIT,
            refresh,
            onProgress
        );
    }

    await cacheEnvelopes(db, cipher, folder.id, result.messages);

    const counts = await db.mailMessages.countByFolder(folder.id);
    const lastSeenUid =
        result.messages.length > 0 ? Math.max(...result.messages.map((m) => m.uid)) : folder.last_seen_uid;
    // `first_seen_uid` never needs moving on a normal incremental sync — only
    // set when unknown (a brand new folder, or a UIDVALIDITY reset that just
    // wiped the cache), backstopped by what's actually in the DB so a folder
    // synced before this column existed still gets a correct floor.
    const firstSeenUid =
        validityKnown && folder.uid_validity === result.uidValidity && folder.first_seen_uid !== null
            ? folder.first_seen_uid
            : await db.mailMessages.minUidByFolder(folder.id);
    await db.mailFolders.updateCounts(folder.id, {
        uidValidity: result.uidValidity,
        lastSeenUid,
        firstSeenUid,
        unreadCount: counts.unseen,
        totalCount: counts.total
    });

    return { newCount: result.messages.length };
}

/**
 * Throws a folder's cache away and rebuilds it from the mailbox as it stands
 * right now. The UID high/low-water marks go with it, so the rebuild takes the
 * same path as a brand new folder — the newest `INITIAL_SYNC_LIMIT` messages —
 * rather than trying to reconcile against marks that are, by assumption, the
 * reason the caller is here. Nothing on the IMAP server is touched.
 */
export async function resetFolder(
    db: Database,
    cipher: Cipher,
    account: MailAccountRow,
    credentials: mailClient.MailCredentials,
    folder: MailFolderRow
): Promise<{ count: number }> {
    await db.mailMessages.deleteByFolder(folder.id);
    const cleared: MailFolderRow = { ...folder, uid_validity: null, last_seen_uid: null, first_seen_uid: null };
    const { newCount } = await syncOneFolder(db, cipher, account, credentials, cleared);
    return { count: newCount };
}

/**
 * Fetches one older batch for a folder, extending its cache backward from
 * `first_seen_uid` — the "force refetch" counterpart to `syncOneFolder`,
 * which only ever moves forward. Never touches `last_seen_uid`. The caller
 * (`mail.folderBackfill`, client-driven) decides whether to call this again
 * based on `reachedStart`.
 */
export async function backfillFolder(
    db: Database,
    cipher: Cipher,
    account: MailAccountRow,
    credentials: mailClient.MailCredentials,
    folder: MailFolderRow,
    limit: number
): Promise<{ addedCount: number; reachedStart: boolean }> {
    const refresh = persistRefreshedToken(db, account.id, credentials, cipher);
    const result = await mailClient.fetchOlderMessages(
        credentials,
        folder.imap_path,
        folder.first_seen_uid,
        limit,
        refresh
    );

    await cacheEnvelopes(db, cipher, folder.id, result.messages);
    await refreshFolderCounts(db, folder);

    return { addedCount: result.messages.length, reachedStart: result.reachedStart };
}
