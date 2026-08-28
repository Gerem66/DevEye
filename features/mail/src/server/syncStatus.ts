/**
 * In-memory, process-local tracker for background sync progress — never
 * persisted, purely for the live "syncing…" progress bar in the account
 * list/back button (see `AccountCard`/`AccountPanel` client-side).
 *
 * Combines two levels: which folder of the account we're on
 * (`foldersDone`/`foldersTotal`), and how far into *that* folder's own
 * message fetch we are (`currentFolderProgress`, fed by `syncFolder`'s
 * `onProgress` — see `client.ts`). The result reads as one smooth
 * 0-1 progress across the whole account instead of jumping once per folder.
 */

interface SyncEntry {
    foldersDone: number;
    foldersTotal: number;
    currentFolderProgress: number;
}

const inProgress = new Map<number, SyncEntry>();

export function beginAccountSync(accountId: number, foldersTotal: number): void {
    inProgress.set(accountId, { foldersDone: 0, foldersTotal, currentFolderProgress: 0 });
}

export function reportFolderProgress(accountId: number, fraction: number): void {
    const entry = inProgress.get(accountId);
    if (entry) entry.currentFolderProgress = Math.min(1, Math.max(0, fraction));
}

export function markFolderSynced(accountId: number): void {
    const entry = inProgress.get(accountId);
    if (entry) {
        entry.foldersDone += 1;
        entry.currentFolderProgress = 0;
    }
}

export function endAccountSync(accountId: number): void {
    inProgress.delete(accountId);
}

export function getAccountSyncStatus(accountId: number): { syncing: boolean; progress: number | null } {
    const entry = inProgress.get(accountId);
    if (!entry) return { syncing: false, progress: null };
    if (entry.foldersTotal === 0) return { syncing: true, progress: null };
    return { syncing: true, progress: (entry.foldersDone + entry.currentFolderProgress) / entry.foldersTotal };
}
