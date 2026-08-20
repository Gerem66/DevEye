import {
    cloudSyncCreateSnapshot,
    cloudSyncDeleteSnapshot,
    cloudSyncDiffSnapshot,
    cloudSyncListSnapshots,
    cloudSyncRestoreSnapshot,
    cloudSyncVerifyIntegrity,
    type CloudSyncSnapshot,
    type SyncSnapshotRow
} from 'deveye-types';

import { defineFeature, FeatureError, type FeatureContext } from '../_define';
import { authorizeShare, requireActiveEngine, requireEngine } from './_shared';

/**
 * Points de restauration du partage ENTIER. Là où une version répond à « rends-
 * moi ce fichier d'avant », un snapshot répond à « remets le dossier comme il
 * était mardi » — ce que la corbeille par fichier ne sait pas faire.
 */

function toClientSnapshot(row: SyncSnapshotRow): CloudSyncSnapshot {
    return {
        id: row.id,
        kind: row.kind,
        label: row.label,
        fileCount: row.file_count,
        totalBytes: row.total_bytes,
        created: row.created
    };
}

/** Charge un snapshot + autorise son partage (il n'a pas d'owner propre). */
async function authorizeSnapshot(ctx: FeatureContext, snapshotId: number): Promise<SyncSnapshotRow> {
    const snapshot = await ctx.db.syncSnapshots.findById(snapshotId);
    if (!snapshot) throw new FeatureError('not_found', 'Point de restauration introuvable');
    await authorizeShare(ctx, snapshot.share_id);
    return snapshot;
}

export const cloudSyncListSnapshotsFeature = defineFeature({
    ...cloudSyncListSnapshots,
    access: { feature: 'cloudsync', level: 'read' },
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const [rows, total] = await Promise.all([
            ctx.db.syncSnapshots.list(share.id, input.limit, input.offset),
            ctx.db.syncSnapshots.count(share.id)
        ]);
        return { snapshots: rows.map(toClientSnapshot), total };
    }
});

export const cloudSyncCreateSnapshotFeature = defineFeature({
    ...cloudSyncCreateSnapshot,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const share = await authorizeShare(ctx, input.shareId);
        const snapshot = await engine.createSnapshot(share, 'manual', input.label ?? null);
        if (snapshot === null) {
            throw new FeatureError('validation', 'Le partage est vide : rien à sauvegarder');
        }

        ctx.audit({
            action: 'cloudSync.createSnapshot',
            description: `CloudSync : point de restauration créé sur « ${share.name} » (${snapshot.file_count} fichier(s))`,
            metadata: { shareId: share.id, snapshotId: snapshot.id }
        });
        return { snapshot: toClientSnapshot(snapshot) };
    }
});

export const cloudSyncDiffSnapshotFeature = defineFeature({
    ...cloudSyncDiffSnapshot,
    access: { feature: 'cloudsync', level: 'read' },
    handler: async (ctx, input) => {
        const engine = requireEngine(ctx);
        const snapshot = await authorizeSnapshot(ctx, input.snapshotId);
        const share = await authorizeShare(ctx, snapshot.share_id);
        return { diff: await engine.diffSnapshot(share, snapshot.id) };
    }
});

export const cloudSyncRestoreSnapshotFeature = defineFeature({
    ...cloudSyncRestoreSnapshot,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const snapshot = await authorizeSnapshot(ctx, input.snapshotId);
        const share = await authorizeShare(ctx, snapshot.share_id);
        // L'audit de l'opération elle-même est écrit par le moteur (il connaît
        // les compteurs exacts et tourne aussi hors requête).
        return engine.restoreSnapshot(share, snapshot);
    }
});

export const cloudSyncDeleteSnapshotFeature = defineFeature({
    ...cloudSyncDeleteSnapshot,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const snapshot = await authorizeSnapshot(ctx, input.snapshotId);
        const share = await authorizeShare(ctx, snapshot.share_id);
        await engine.deleteSnapshot(share, snapshot.id);

        ctx.audit({
            action: 'cloudSync.deleteSnapshot',
            level: 'warning',
            description: `CloudSync : point de restauration supprimé sur « ${share.name} »`,
            metadata: { shareId: share.id, snapshotId: snapshot.id }
        });
        return { ok: true };
    }
});

export const cloudSyncVerifyIntegrityFeature = defineFeature({
    ...cloudSyncVerifyIntegrity,
    access: { feature: 'cloudsync', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const share = await authorizeShare(ctx, input.shareId);
        // `null` = passage complet : c'est un geste délibéré de l'utilisateur,
        // pas le petit budget du balayage de fond.
        const report = await engine.verifyIntegrity(share, null);

        ctx.audit({
            action: 'cloudSync.verifyIntegrity',
            level: report.corrupted > 0 ? 'warning' : 'info',
            description: `CloudSync : intégrité vérifiée sur « ${share.name} » (${report.checked} contenu(s), ${report.corrupted} corrompu(s), ${report.repaired} réparé(s))`,
            metadata: { shareId: share.id, ...report }
        });
        return report;
    }
});
