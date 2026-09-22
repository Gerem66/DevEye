import { MAIL_MESSAGE_PAGE_SIZE, type MailFolderRow } from '../contracts/domain';
import type { SdkCipher } from '@deveye/types/sdk/server';

import type { MailSession, RemoteEnvelope } from './client';
import type { MailRepo } from './repo';
import { encryptEnvelope } from './_shared';

/**
 * Sync logic shared between the on-demand commands (live WS session) and the
 * background tick of `service.ts` for "open"-tier accounts (no session). Both
 * sides hand it an open {@link MailSession} and the right cipher for the
 * account's tier: this module only talks to IMAP and writes the metadata cache,
 * nothing about auth/gating.
 */

/** Ce que la relève demande à `client.ts` : l'ouverture d'une session, qu'un test simule. */
export type SyncClient = Pick<typeof import('./client'), 'withSession'>;

/** First-sync cap: how many of a folder's most recent messages to backfill. */
export const INITIAL_SYNC_LIMIT = 200;

/**
 * Ce qu'une relève a appris d'un dossier ; la somme des trois décide si le
 * contenu a bougé, et donc s'il faut prévenir les clients connectés.
 */
export interface SyncFolderOutcome {
    newCount: number;
    changedCount: number;
    removedCount: number;
}

/** Cache one folder's worth of fetched envelopes, for a forward sync, a backfill or a remote search. */
export async function cacheEnvelopes(
    repo: MailRepo,
    cipher: SdkCipher,
    folderId: number,
    messages: RemoteEnvelope[]
): Promise<void> {
    for (const msg of messages) {
        await repo.messages.upsertEnvelope({
            folderId,
            uid: msg.uid,
            // The snippet needs the body, which a sync never fetches: empty by design.
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
 * outside a forward sync (a backfill or a remote search), which write *older*
 * messages and so can only move `first_seen_uid` down. `last_seen_uid` and
 * `uid_validity` are carried through untouched: neither operation learns
 * anything about the top of the mailbox.
 */
export async function refreshFolderCounts(repo: MailRepo, folder: MailFolderRow): Promise<void> {
    const counts = await repo.messages.countByFolder(folder.id);
    await repo.folders.updateCounts(folder.id, {
        uidValidity: folder.uid_validity,
        lastSeenUid: folder.last_seen_uid,
        firstSeenUid: await repo.messages.minUidByFolder(folder.id),
        unreadCount: counts.unseen,
        totalCount: counts.total
    });
}

/** Refresh the folder list from IMAP and upsert it into `mail_folders`. */
export async function syncAccountFolders(
    session: MailSession,
    repo: MailRepo,
    cipher: SdkCipher,
    accountId: number
): Promise<MailFolderRow[]> {
    const remote = await session.listFolders();
    for (const folder of remote) {
        await repo.folders.upsert({
            accountId,
            imapPath: folder.imapPath,
            nameEnc: await cipher.encrypt(folder.name),
            specialUse: folder.specialUse,
            uidValidity: null
        });
    }
    return repo.folders.listByAccount(accountId);
}

/**
 * Pull new envelopes for one folder, reconcile the recent window already cached,
 * and refresh the folder's counts. A `UIDVALIDITY` change (mailbox recreated
 * server-side) drops the stale cache and re-fetches, so a folder never mixes two
 * UID spaces.
 *
 * Le fetch avant n'apprend que les arrivées : un message déjà connu n'y
 * réapparaît jamais. La réconciliation est l'autre moitié du travail, et la
 * seule façon d'apprendre qu'un mail a été lu, marqué ou supprimé ailleurs.
 */
export async function syncOneFolder(
    session: MailSession,
    repo: MailRepo,
    cipher: SdkCipher,
    folder: MailFolderRow,
    /** Message-level progress within this one folder. */
    onProgress?: (done: number, estimatedTotal: number) => void
): Promise<SyncFolderOutcome> {
    let sinceUid = folder.last_seen_uid;

    // Fenêtre à réconcilier, lue avant tout fetch. Bornée par le plus haut UID
    // du cache et non par `last_seen_uid` : une recherche distante peut avoir
    // inséré des lignes au-dessus de ce repère sans le faire bouger.
    let window =
        folder.uid_validity === null ? [] : await repo.messages.listFlagsWindow(folder.id, MAIL_MESSAGE_PAGE_SIZE);
    const reconcile = window.length > 0 ? { fromUid: window[window.length - 1].uid, toUid: window[0].uid } : null;

    let result = await session.syncFolder({
        imapPath: folder.imap_path,
        sinceUid,
        initialLimit: INITIAL_SYNC_LIMIT,
        reconcile,
        onProgress
    });

    const validityKnown = folder.uid_validity !== null;
    if (validityKnown && folder.uid_validity !== result.uidValidity) {
        // The mailbox was recreated: our cached UIDs no longer mean anything.
        await repo.messages.deleteByFolder(folder.id);
        sinceUid = null;
        // Cache détruit : plus rien à réconcilier, ni ici ni au retour.
        window = [];
        result = await session.syncFolder({
            imapPath: folder.imap_path,
            sinceUid,
            initialLimit: INITIAL_SYNC_LIMIT,
            reconcile: null,
            onProgress
        });
    }

    await cacheEnvelopes(repo, cipher, folder.id, result.messages);

    // Sur la fenêtre relue, la réponse du serveur fait foi.
    let changedCount = 0;
    let removedCount = 0;
    if (result.reconciled) {
        const remote = new Map(result.reconciled.map((m) => [m.uid, m]));
        for (const row of window) {
            const live = remote.get(row.uid);
            if (!live) continue;
            if (
                (row.seen === 1) !== live.seen ||
                (row.flagged === 1) !== live.flagged ||
                (row.answered === 1) !== live.answered
            ) {
                await repo.messages.updateFlags(row.id, live);
                changedCount++;
            }
        }
        // Un UID de la fenêtre que le serveur ne rend plus n'existe plus là-bas :
        // supprimé, ou déplacé (un MOVE lui donne un UID neuf dans le dossier
        // d'arrivée). Le garder, c'est afficher un mail fantôme.
        removedCount = await repo.messages.deleteByFolderUids(
            folder.id,
            window.filter((row) => !remote.has(row.uid)).map((row) => row.uid)
        );
    }

    const counts = await repo.messages.countByFolder(folder.id);
    // Repère haut, et non « le plus récent qui existe » : une suppression en tête
    // ne le fait pas redescendre, sans quoi les UID que la réconciliation vient
    // de retirer rentreraient au tick suivant.
    const lastSeenUid =
        result.messages.length > 0 ? Math.max(...result.messages.map((m) => m.uid)) : folder.last_seen_uid;
    // `first_seen_uid` never moves on a normal incremental sync: it is only set
    // when unknown (a brand new folder, or a UIDVALIDITY reset that wiped the
    // cache). Une réconciliation qui a supprimé des lignes fait exception : elle
    // a pu emporter le plancher lui-même.
    const firstSeenUid =
        removedCount === 0 &&
        validityKnown &&
        folder.uid_validity === result.uidValidity &&
        folder.first_seen_uid !== null
            ? folder.first_seen_uid
            : await repo.messages.minUidByFolder(folder.id);
    await repo.folders.updateCounts(folder.id, {
        uidValidity: result.uidValidity,
        lastSeenUid,
        firstSeenUid,
        unreadCount: counts.unseen,
        totalCount: counts.total
    });

    return { newCount: result.messages.length, changedCount, removedCount };
}

/**
 * Throws a folder's cache away and rebuilds it from the mailbox as it stands
 * right now, UID marks included, so the rebuild takes the same path as a brand
 * new folder rather than reconciling against marks that are, by assumption, the
 * reason the caller is here. Nothing on the IMAP server is touched.
 *
 * Réparation de dernier recours : la seule à remettre d'aplomb ce qui a dérivé
 * au-delà de la fenêtre que {@link syncOneFolder} réconcilie à chaque passage.
 */
export async function resetFolder(
    session: MailSession,
    repo: MailRepo,
    cipher: SdkCipher,
    folder: MailFolderRow
): Promise<{ count: number }> {
    await repo.messages.deleteByFolder(folder.id);
    const cleared: MailFolderRow = { ...folder, uid_validity: null, last_seen_uid: null, first_seen_uid: null };
    const { newCount } = await syncOneFolder(session, repo, cipher, cleared);
    return { count: newCount };
}

/**
 * Fetches one older batch for a folder, extending its cache backward from
 * `first_seen_uid`, the counterpart to `syncOneFolder`, which only ever moves
 * forward. Never touches `last_seen_uid`. The caller decides whether to call
 * this again based on `reachedStart`.
 */
export async function backfillFolder(
    session: MailSession,
    repo: MailRepo,
    cipher: SdkCipher,
    folder: MailFolderRow,
    limit: number
): Promise<{ addedCount: number; reachedStart: boolean }> {
    const result = await session.fetchOlderMessages(folder.imap_path, folder.first_seen_uid, limit);

    await cacheEnvelopes(repo, cipher, folder.id, result.messages);
    await refreshFolderCounts(repo, folder);

    return { addedCount: result.messages.length, reachedStart: result.reachedStart };
}
