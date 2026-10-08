import type { MailBackupFlag, MailBackupMailbox, MailServerBackupProvider } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { BlobStore } from './engine/blobs';
import type { MailboxRow, MailserverRepo } from './repo';

/** Les bits de `flags`, tels que le moteur IMAP les pose. */
const FLAG_BITS: readonly (readonly [number, MailBackupFlag])[] = [
    [1, 'seen'],
    [2, 'answered'],
    [4, 'flagged'],
    [8, 'deleted'],
    [16, 'draft']
];

const keywordsOf = (raw: string): string[] => raw.split(' ').filter((k) => k !== '');

const view = (row: MailboxRow): MailBackupMailbox => ({
    id: row.id,
    address: row.address,
    workspaceId: row.workspace_id,
    messageCount: Number(row.message_count),
    bytes: Number(row.used_bytes)
});

/**
 * Ce que Sauvegardes consomme : les adresses de l'espace, leurs dossiers et
 * leurs messages en clair. La clé d'une boîte s'ouvre par celle du serveur,
 * sans session : une sauvegarde tourne la nuit.
 */
export function createBackupProvider(
    deps: FeatureServiceDeps<MailserverRepo>,
    blobs: BlobStore
): MailServerBackupProvider {
    const { repo } = deps;
    // Une archive parcourt une boîte d'un bout à l'autre : sa clé s'ouvre une fois.
    let lastKey: { mailboxId: number; key: Buffer } | null = null;

    const keyOf = async (mailboxId: number): Promise<Buffer | null> => {
        if (lastKey?.mailboxId === mailboxId) return lastKey.key;
        const mailbox = await repo.findById(mailboxId);
        if (!mailbox) return null;
        const opened = deps.keys.openBytes(mailbox.blob_key);
        if (opened === null)
            throw new Error(`La clé de l’adresse ${mailbox.address} ne s’ouvre plus avec celle du serveur.`);
        lastKey = { mailboxId, key: Buffer.from(opened) };
        return lastKey.key;
    };

    return {
        async listMailboxes(workspaceId) {
            return (await repo.listOwned(workspaceId)).map(view);
        },
        async findMailbox(mailboxId, workspaceId) {
            const row = await repo.find(mailboxId, workspaceId);
            return row ? view(row) : null;
        },
        async folders(mailboxId) {
            const [folders, sets] = await Promise.all([repo.listFolders(mailboxId), repo.folderKeywords(mailboxId)]);
            const keywords = new Map<number, Set<string>>();
            for (const set of sets) {
                const known = keywords.get(set.folder_id) ?? new Set<string>();
                for (const keyword of keywordsOf(set.keywords)) known.add(keyword);
                keywords.set(set.folder_id, known);
            }
            return folders.map((folder) => ({
                id: folder.id,
                path: folder.path,
                specialUse: folder.special_use,
                subscribed: folder.subscribed === 1,
                keywords: [...(keywords.get(folder.id) ?? [])].sort()
            }));
        },
        async messages(_mailboxId, folderId, afterUid, limit) {
            const rows = await repo.backupPage(folderId, afterUid, limit);
            return rows.map((row) => ({
                id: row.id,
                uid: row.uid,
                size: row.size,
                internalDate: row.internal_date,
                flags: FLAG_BITS.filter(([bit]) => (row.flags & bit) !== 0).map(([, flag]) => flag),
                keywords: keywordsOf(row.keywords)
            }));
        },
        async open(mailboxId, messageId) {
            const key = await keyOf(mailboxId);
            const ref = key ? await repo.messageRef(mailboxId, messageId) : null;
            return key && ref ? blobs.open(mailboxId, key, ref) : null;
        },
        // Qui peut changer le mot de passe d'une adresse peut en lire le courrier ;
        // l'écriture seule règle la boîte sans jamais y entrer.
        authorize: (mailboxId, workspaceId, userId) =>
            deps.access.feature(workspaceId, userId, {
                level: 'write',
                extras: ['managePasswords'],
                itemId: String(mailboxId)
            })
    };
}
