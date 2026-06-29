import {
    deviceFilesAnalyze,
    deviceFilesDownload,
    deviceFilesList,
    deviceFilesMutate,
    deviceFilesSearch,
    deviceFilesUpload
} from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeReachableDevice } from './shared';

/**
 * File explorer commands for a device. Owner-or-admin + agent online. Read ops
 * (list/analyze/search) only acknowledge; results stream back as `device.files*`
 * push events keyed by `opId` (the caller must be subscribed). Mutations are
 * audited (cleanup is destructive).
 */

export const deviceFilesListFeature: FeatureDefinition<
    typeof deviceFilesList.command,
    typeof deviceFilesList.input,
    typeof deviceFilesList.output
> = defineFeature({
    ...deviceFilesList,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesList(row.id, { opId: input.opId, path: input.path });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const deviceFilesAnalyzeFeature: FeatureDefinition<
    typeof deviceFilesAnalyze.command,
    typeof deviceFilesAnalyze.input,
    typeof deviceFilesAnalyze.output
> = defineFeature({
    ...deviceFilesAnalyze,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesAnalyze(row.id, { opId: input.opId, path: input.path });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const deviceFilesSearchFeature: FeatureDefinition<
    typeof deviceFilesSearch.command,
    typeof deviceFilesSearch.input,
    typeof deviceFilesSearch.output
> = defineFeature({
    ...deviceFilesSearch,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesSearch(row.id, {
            opId: input.opId,
            path: input.path,
            filter: input.filter
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/** French label per mutation, for the audit description. */
const MUTATE_LABELS: Record<string, string> = {
    delete: 'Suppression',
    mkdir: 'Création de dossier',
    rename: 'Renommage'
};

export const deviceFilesMutateFeature: FeatureDefinition<
    typeof deviceFilesMutate.command,
    typeof deviceFilesMutate.input,
    typeof deviceFilesMutate.output
> = defineFeature({
    ...deviceFilesMutate,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesMutate(row.id, {
            opId: input.opId,
            op: input.op,
            path: input.path,
            dest: input.dest
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.filesMutate',
            level: input.op === 'delete' ? 'warning' : 'info',
            description: `${MUTATE_LABELS[input.op]} : « ${row.name} » — ${input.path}${input.dest ? ` → ${input.dest}` : ''}`,
            metadata: {
                deviceId: row.id,
                ownerId: row.owner_id,
                op: input.op,
                path: input.path,
                dest: input.dest ?? null
            }
        });
        return { ok: true };
    }
});

/** Download a file: chunks stream back as `device.filesChunk` push events. */
export const deviceFilesDownloadFeature: FeatureDefinition<
    typeof deviceFilesDownload.command,
    typeof deviceFilesDownload.input,
    typeof deviceFilesDownload.output
> = defineFeature({
    ...deviceFilesDownload,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesDownload(row.id, { opId: input.opId, path: input.path });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/**
 * Upload one chunk of a file. The first chunk (offset 0) is audited as the upload;
 * later chunks just stream the bytes. Completion arrives as a `device.filesOp` push.
 */
export const deviceFilesUploadFeature: FeatureDefinition<
    typeof deviceFilesUpload.command,
    typeof deviceFilesUpload.input,
    typeof deviceFilesUpload.output
> = defineFeature({
    ...deviceFilesUpload,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesUpload(row.id, {
            opId: input.opId,
            path: input.path,
            offset: input.offset,
            data: input.data,
            done: input.done
        });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        if (input.offset === 0) {
            ctx.audit({
                action: 'device.filesUpload',
                description: `Téléversement : « ${row.name} » — ${input.path}`,
                metadata: { deviceId: row.id, ownerId: row.owner_id, path: input.path }
            });
        }
        return { ok: true };
    }
});
