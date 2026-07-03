import type { SyncFileRow, SyncVersionReason, SyncVersionRow } from 'deveye-types';
import type { Database } from '../db';
import type { ShareBlobStore } from './blobStore';

/**
 * Verrou unique de l'invariant « archive-avant-destruction » : TOUTE voie qui
 * écrase ou supprime du contenu (upload par-dessus, suppression propagée,
 * conflit, restauration) passe par l'une des deux fonctions d'archivage — qui
 * refusent de continuer si le blob n'est pas physiquement présent. Un throw
 * ici annule la mutation appelante : rien n'est perdu.
 */

async function assertBlobPresent(store: ShareBlobStore, relPath: string, hash: string): Promise<void> {
    if (!(await store.has(hash))) {
        throw new Error(
            `CloudSync : blob absent pour « ${relPath} » (${hash}) — archivage impossible, mutation annulée`
        );
    }
}

/** Archive le contenu courant d'une ligne d'index comme version. */
export async function archiveCurrent(
    db: Database,
    store: ShareBlobStore,
    fileRow: SyncFileRow,
    reason: SyncVersionReason
): Promise<SyncVersionRow> {
    await assertBlobPresent(store, fileRow.rel_path, fileRow.hash);
    return db.syncVersions.insert({
        shareId: fileRow.share_id,
        relPath: fileRow.rel_path,
        hash: fileRow.hash,
        size: fileRow.size,
        mtime: fileRow.mtime,
        sourceDeviceId: fileRow.source_device_id,
        reason
    });
}

/**
 * Archive un blob déjà vérifié qui n'est PAS le contenu courant de l'index —
 * le perdant d'un conflit remonté depuis l'appareil, typiquement.
 */
export async function archiveBlobAsVersion(
    db: Database,
    store: ShareBlobStore,
    input: {
        shareId: number;
        relPath: string;
        hash: string;
        size: number;
        mtime: number | null;
        sourceDeviceId: string | null;
        reason: SyncVersionReason;
    }
): Promise<SyncVersionRow> {
    await assertBlobPresent(store, input.relPath, input.hash);
    return db.syncVersions.insert(input);
}

/**
 * Détruit physiquement un blob si plus rien (index vivant ∪ versions) ne le
 * référence. Seule porte de sortie d'un blob — à n'appeler que sous le mutex
 * du partage (sessions, purge et suppression de version y sont sérialisées).
 */
export async function gcBlobIfUnreferenced(
    db: Database,
    store: ShareBlobStore,
    shareId: number,
    hash: string
): Promise<boolean> {
    if (await db.syncFiles.isHashReferenced(shareId, hash)) return false;
    await store.deleteBlob(hash);
    return true;
}
