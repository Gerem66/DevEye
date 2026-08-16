import {
    cloudSyncCreateShare,
    cloudSyncDeleteShare,
    cloudSyncListShares,
    cloudSyncReorderShares,
    cloudSyncUpdateShare
} from 'deveye-types';

import { storagePathForName, validateStoragePath } from '@/cloudSync/pathValidation';
import { defineFeature, FeatureError } from '../_define';
import { authorizeShare, requireActiveEngine, toClientShare } from './_shared';

export const cloudSyncListSharesFeature = defineFeature({
    ...cloudSyncListShares,
    handler: async (ctx) => {
        const rows = await ctx.db.syncShares.listByWorkspace(ctx.workspaceId);
        return { shares: await Promise.all(rows.map((r) => toClientShare(ctx, r))) };
    }
});

export const cloudSyncCreateShareFeature = defineFeature({
    ...cloudSyncCreateShare,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
        // Le chemin n'est plus saisi : l'utilisateur n'a aucune raison de
        // connaître l'arborescence du serveur, et le lui demander est
        // précisément ce qui menait à créer un partage sur une couche éphémère
        // de conteneur. Il est dérivé du nom, sous la racine persistante.
        const storagePath = await storagePathForName(ctx.db, input.name);
        const verdict = await validateStoragePath(ctx.db, storagePath);
        if (!verdict.ok) {
            throw new FeatureError(
                'internal',
                `Le stockage du serveur n'est pas utilisable (${verdict.problem ?? 'raison inconnue'}). Vérifie CLOUDSYNC_STORAGE_ROOT et son montage.`
            );
        }

        const row = await ctx.db.syncShares.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            name: input.name.trim(),
            storagePath
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
            snapshotEnabled: input.snapshotEnabled ?? Boolean(row.snapshot_enabled),
            snapshotIntervalHours: input.snapshotIntervalHours ?? row.snapshot_interval_hours,
            snapshotKeepDays: input.snapshotKeepDays ?? row.snapshot_keep_days,
            integrityScanEnabled: input.integrityScanEnabled ?? Boolean(row.integrity_scan_enabled),
            rateUpBps: input.rateUpBps === undefined ? row.rate_up_bps : input.rateUpBps,
            rateDownBps: input.rateDownBps === undefined ? row.rate_down_bps : input.rateDownBps,
            trashKeepDays: input.trashKeepDays ?? row.trash_keep_days,
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

export const cloudSyncReorderSharesFeature = defineFeature({
    ...cloudSyncReorderShares,
    mutates: true,
    handler: async (ctx, input) => {
        // Volontairement SANS `requireActiveEngine` : ranger sa liste ne touche
        // ni un fichier, ni un index, ni une session. Une instance passive peut
        // donc l'accepter — refuser reviendrait à figer l'interface pour une
        // opération qui n'a rien à voir avec le moteur.
        //
        // Pas de contrôle d'appartenance non plus : la clause `workspace_id` du
        // dépôt ignore en silence tout identifiant venu d'ailleurs, donc un `ids`
        // forgé ne peut ranger que ce que l'espace possède déjà.
        await ctx.db.syncShares.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const cloudSyncDeleteShareFeature = defineFeature({
    ...cloudSyncDeleteShare,
    mutates: true,
    handler: async (ctx, input) => {
        const engine = requireActiveEngine(ctx);
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
