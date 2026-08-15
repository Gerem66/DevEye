import {
    cloudSyncClearVersions,
    cloudSyncDeleteVersion,
    cloudSyncDeleteVersions,
    cloudSyncDownloadFile,
    cloudSyncDownloadVersion,
    cloudSyncListVersions,
    cloudSyncRestoreVersion,
    type SyncVersionRow
} from 'deveye-types';

import { relPathHash, safeRelPath } from '@/cloudSync/pathValidation';
import { defineFeature, FeatureError, type FeatureContext } from '../_define';
import { authorizeShare, requireActiveEngine, requireEngine, toClientVersion } from './_shared';

/** Charge une version + autorise son partage (les versions n'ont pas d'owner propre). */
async function authorizeVersion(
    ctx: FeatureContext,
    versionId: number
): Promise<{ version: SyncVersionRow; shareId: number }> {
    const version = await ctx.db.syncVersions.findById(versionId);
    if (!version) throw new FeatureError('not_found', 'Version introuvable');
    await authorizeShare(ctx, version.share_id);
    return { version, shareId: version.share_id };
}

export const cloudSyncListVersionsFeature = defineFeature({
    ...cloudSyncListVersions,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const relPath = input.relPath === undefined ? null : safeRelPath(input.relPath);
        if (input.relPath !== undefined && relPath === null) {
            throw new FeatureError('validation', 'Chemin invalide');
        }
        const [rows, totals] = await Promise.all([
            ctx.db.syncVersions.list(share.id, relPath, input.sort ?? 'newest', input.limit, input.offset),
            ctx.db.syncVersions.totals(share.id, relPath)
        ]);
        return { versions: rows.map(toClientVersion), total: totals.total, totalBytes: totals.totalBytes };
    }
});

export const cloudSyncRestoreVersionFeature = defineFeature({
    ...cloudSyncRestoreVersion,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const { version } = await authorizeVersion(ctx, input.versionId);
        const share = await authorizeShare(ctx, version.share_id);
        await engine.restoreVersion(share, version);

        ctx.audit({
            action: 'cloudSync.restoreVersion',
            description: `CloudSync : version restaurée pour « ${version.rel_path} » sur « ${share.name} »`,
            metadata: { shareId: share.id, versionId: version.id, relPath: version.rel_path }
        });
        return { ok: true };
    }
});

export const cloudSyncDeleteVersionFeature = defineFeature({
    ...cloudSyncDeleteVersion,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const { version } = await authorizeVersion(ctx, input.versionId);
        const share = await authorizeShare(ctx, version.share_id);
        await engine.deleteVersion(share, version);

        ctx.audit({
            action: 'cloudSync.deleteVersion',
            level: 'warning',
            description: `CloudSync : version supprimée pour « ${version.rel_path} » sur « ${share.name} »`,
            metadata: { shareId: share.id, versionId: version.id, relPath: version.rel_path }
        });
        return { ok: true };
    }
});

export const cloudSyncDeleteVersionsFeature = defineFeature({
    ...cloudSyncDeleteVersions,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const share = await authorizeShare(ctx, input.shareId);
        const deleted = await engine.deleteVersions(share, input.versionIds);

        ctx.audit({
            action: 'cloudSync.deleteVersions',
            level: 'warning',
            description: `CloudSync : ${deleted} sauvegarde(s) supprimée(s) sur « ${share.name} »`,
            metadata: { shareId: share.id, count: deleted }
        });
        return { deleted };
    }
});

export const cloudSyncClearVersionsFeature = defineFeature({
    ...cloudSyncClearVersions,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        const share = await authorizeShare(ctx, input.shareId);
        const deleted = await engine.clearVersions(share);

        ctx.audit({
            action: 'cloudSync.clearVersions',
            level: 'warning',
            description: `CloudSync : corbeille vidée (${deleted} sauvegarde(s)) sur « ${share.name} »`,
            metadata: { shareId: share.id, count: deleted }
        });
        return { deleted };
    }
});

export const cloudSyncDownloadVersionFeature = defineFeature({
    ...cloudSyncDownloadVersion,
    handler: async (ctx, input) => {
        const engine = requireEngine(ctx);
        if (!ctx.monitor) throw new FeatureError('internal', 'Connexion temps réel requise');
        const { version } = await authorizeVersion(ctx, input.versionId);
        const share = await authorizeShare(ctx, version.share_id);
        // Fire-and-forget : les octets partent en pushes `cloudSync.chunk`.
        engine.streamBlobToSocket(ctx.monitor, share, version.hash, input.opId);
        return { ok: true, size: version.size };
    }
});

export const cloudSyncDownloadFileFeature = defineFeature({
    ...cloudSyncDownloadFile,
    handler: async (ctx, input) => {
        const engine = requireEngine(ctx);
        if (!ctx.monitor) throw new FeatureError('internal', 'Connexion temps réel requise');
        const share = await authorizeShare(ctx, input.shareId);
        const relPath = safeRelPath(input.relPath);
        if (relPath === null) throw new FeatureError('validation', 'Chemin invalide');
        const row = await ctx.db.syncFiles.getByRelPathHash(share.id, relPathHash(relPath));
        if (!row || row.state !== 'present') throw new FeatureError('not_found', 'Fichier introuvable');
        engine.streamBlobToSocket(ctx.monitor, share, row.hash, input.opId);
        return { ok: true, size: row.size };
    }
});
