import type { Logger } from 'pino';
import type { Database } from '../db';
import type { ShareBlobStore } from './blobStore';

/**
 * Contrôle d'intégrité du blob store.
 *
 * Le store vérifie déjà tout à la LECTURE (scellés GCM + SHA-256 du clair
 * comparé au nom). Le problème est qu'une corruption au repos — bit pourri,
 * secteur défaillant, coupure pendant une écriture — ne se découvre alors qu'au
 * moment où quelqu'un demande le fichier, c'est-à-dire au pire moment possible
 * pour un système de sauvegarde. Ce module va donc au-devant.
 *
 * Deux usages, une seule mécanique :
 *  - passage complet à la demande (bouton de l'interface) ;
 *  - petit budget par tour de prune horaire, reprenant où le tour précédent
 *    s'est arrêté (curseur dans `sync_meta`), pour finir par tout couvrir sans
 *    jamais se faire remarquer.
 *
 * **Auto-réparation** : un blob corrompu dont un appareil EN LIGNE détient
 * encore le contenu est simplement redemandé. C'est possible parce que la
 * baseline dit, pour chaque appareil, quel hash il possède à quel chemin.
 */

/** Budget par tour de balayage de fond. Quelques centaines de Mo par heure. */
export const INTEGRITY_BUDGET_BYTES = 512 * 1024 * 1024;

const CURSOR_KEY = (shareId: number): string => `integrity_cursor_${shareId}`;

export interface IntegrityReport {
    checked: number;
    bytes: number;
    corrupted: number;
    repaired: number;
}

/** Ce qu'il faut pour aller rechercher un contenu perdu auprès d'un appareil. */
export interface BlobRepairer {
    /** Redemande ce hash à un appareil en ligne qui l'a. `true` si réparé. */
    repair(shareId: number, hash: string): Promise<boolean>;
}

/**
 * Vérifie les blobs d'un partage. `budgetBytes` à `null` = tout, d'un trait
 * (bouton manuel) ; sinon on s'arrête au budget et on mémorise où reprendre.
 *
 * Les hashes sont parcourus dans un ordre stable (tri) et le curseur retient le
 * dernier hash vu : un blob ajouté entre deux tours n'échappe donc pas au
 * balayage suivant, et aucun n'est vérifié deux fois dans le même cycle.
 */
export async function verifyShareBlobs(
    db: Database,
    store: ShareBlobStore,
    shareId: number,
    logger: Logger,
    options: { budgetBytes: number | null; repairer?: BlobRepairer }
): Promise<IntegrityReport> {
    const report: IntegrityReport = { checked: 0, bytes: 0, corrupted: 0, repaired: 0 };
    const hashes = await db.syncFiles.allReferencedHashes(shareId);
    if (hashes.length === 0) {
        await db.syncMeta.set(CURSOR_KEY(shareId), '');
        return report;
    }

    let start = 0;
    if (options.budgetBytes !== null) {
        const cursor = (await db.syncMeta.get(CURSOR_KEY(shareId))) ?? '';
        // `findIndex` plutôt qu'une position numérique : la liste bouge entre
        // deux tours, un index brut désignerait n'importe quoi.
        if (cursor !== '') {
            const at = hashes.indexOf(cursor);
            start = at === -1 ? 0 : at + 1;
        }
    }

    let last = '';
    for (let i = start; i < hashes.length; i += 1) {
        const hash = hashes[i];
        last = hash;
        try {
            report.bytes += await store.verify(hash);
            report.checked += 1;
        } catch (err) {
            report.corrupted += 1;
            logger.error({ err, shareId, hash }, 'CloudSync: corrupted blob detected');
            const repaired = (await options.repairer?.repair(shareId, hash)) ?? false;
            if (repaired) report.repaired += 1;
            await db.syncEvents
                .insert({
                    shareId,
                    deviceId: null,
                    relPath: null,
                    message: repaired
                        ? `Contenu corrompu détecté puis réparé depuis un appareil (${hash.slice(0, 12)}…)`
                        : `Contenu corrompu détecté et IRRÉCUPÉRABLE (${hash.slice(0, 12)}…) : aucun appareil en ligne ne le détient. Les fichiers concernés sont à re-déposer.`
                })
                .catch(() => undefined);
        }
        if (options.budgetBytes !== null && report.bytes >= options.budgetBytes) {
            await db.syncMeta.set(CURSOR_KEY(shareId), last);
            return report;
        }
    }

    // Tour complet : le curseur repart de zéro pour le cycle suivant.
    await db.syncMeta.set(CURSOR_KEY(shareId), '');
    return report;
}
