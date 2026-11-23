/**
 * In-memory, process-local tracker for background sync progress, never
 * persisted: it feeds the live "syncing…" progress bar.
 *
 * Combines two levels, which folder of the account we're on and how far into
 * that folder's own message fetch we are, so the whole account reads as one
 * smooth 0-1 progress instead of jumping once per folder.
 */

interface SyncEntry {
    foldersDone: number;
    foldersTotal: number;
    currentFolderProgress: number;
}

const inProgress = new Map<number, SyncEntry>();

/**
 * Les comptes à qui une boîte a été rendue dans leur liste : son avancement
 * n'est poussé qu'à eux. Un membre à qui son rôle masque la boîte n'y entre
 * jamais, là où une diffusion à tout l'espace lui en apprendrait l'existence.
 */
const listedTo = new Map<number, Set<number>>();

export function noteAccountListed(accountId: number, userId: number): void {
    const users = listedTo.get(accountId) ?? new Set<number>();
    users.add(userId);
    listedTo.set(accountId, users);
}

export function accountWatchers(accountId: number): number[] {
    return [...(listedTo.get(accountId) ?? [])];
}

export function forgetAccountWatchers(accountId: number): void {
    listedTo.delete(accountId);
}

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
