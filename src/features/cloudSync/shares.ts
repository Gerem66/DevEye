import {
    cloudSyncCreateShare,
    cloudSyncDeleteShare,
    cloudSyncListShares,
    cloudSyncUpdateShare,
    cloudSyncValidatePath
} from 'deveye-types';

import { canonicalStoragePath, validateStoragePath } from '@/cloudSync/pathValidation';
import { defineFeature, FeatureError } from '../_define';
import { authorizeShare, requireEngine, toClientShare } from './_shared';

export const cloudSyncListSharesFeature = defineFeature({
    ...cloudSyncListShares,
    handler: async (ctx) => {
        const rows = await ctx.db.syncShares.listByWorkspace(ctx.workspaceId);
        return { shares: await Promise.all(rows.map((r) => toClientShare(ctx, r))) };
    }
});

export const cloudSyncValidatePathFeature = defineFeature({
    ...cloudSyncValidatePath,
    handler: async (ctx, input) => validateStoragePath(ctx.db, input.path)
});

export const cloudSyncCreateShareFeature = defineFeature({
    ...cloudSyncCreateShare,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireEngine(ctx);
        const verdict = await validateStoragePath(ctx.db, input.storagePath);
        if (!verdict.ok) throw new FeatureError('validation', verdict.problem ?? 'Chemin invalide');

        const row = await ctx.db.syncShares.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            name: input.name.trim(),
            storagePath: canonicalStoragePath(input.storagePath)
        });
        await engine.storeFor(row); // Initialise blobs/ et tmp/ tout de suite.

        ctx.audit({
            action: 'cloudSync.createShare',
            description: `Partage CloudSync créé : « ${row.name} »`,
            metadata: { shareId: row.id, storagePath: row.storage_path }
        });
        return { share: await toClientShare(ctx, row) };
    }
});

export const cloudSyncUpdateShareFeature = defineFeature({
    ...cloudSyncUpdateShare,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeShare(ctx, input.shareId);
        const pruneEnabled = input.backupPruneEnabled ?? Boolean(row.backup_prune_enabled);
        const limitBytes = input.backupLimitBytes === undefined ? row.backup_limit_bytes : input.backupLimitBytes;
        if (pruneEnabled && limitBytes === null) {
            throw new FeatureError('validation', 'La purge automatique exige une taille limite.');
        }
        const updated = await ctx.db.syncShares.update(row.id, {
            name: (input.name ?? row.name).trim(),
            backupPruneEnabled: pruneEnabled,
            backupLimitBytes: limitBytes,
            conflictPolicy: input.conflictPolicy ?? row.conflict_policy
        });
        if (!updated) throw new FeatureError('not_found', 'Partage introuvable');

        ctx.audit({
            action: 'cloudSync.updateShare',
            description: `Partage CloudSync modifié : « ${updated.name} »`,
            metadata: { shareId: updated.id, pruneEnabled, limitBytes }
        });
        return { share: await toClientShare(ctx, updated) };
    }
});

export const cloudSyncDeleteShareFeature = defineFeature({
    ...cloudSyncDeleteShare,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireEngine(ctx);
        const row = await authorizeShare(ctx, input.shareId);
        await engine.deleteShare(row, input.deleteData);

        ctx.audit({
            action: 'cloudSync.deleteShare',
            level: 'warning',
            description: `Partage CloudSync supprimé : « ${row.name} »${input.deleteData ? ' (données effacées)' : ''}`,
            metadata: { shareId: row.id, deleteData: input.deleteData }
        });
        return { ok: true };
    }
});
