import {
    agentFilesAnalyze,
    agentFilesDownload,
    agentFilesList,
    agentFilesMutate,
    agentFilesSearch,
    agentFilesUpload
} from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * File explorer commands for a device. Owner-or-admin + agent online. Read ops
 * (list/analyze/search) only acknowledge; results stream back as `device.files*`
 * push events keyed by `opId` (the caller must be subscribed). Mutations are
 * audited (cleanup is destructive).
 */

export const agentFilesListFeature: FeatureDefinition<
    typeof agentFilesList.command,
    typeof agentFilesList.input,
    typeof agentFilesList.output
> = defineFeature({
    ...agentFilesList,
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesList(row.id, { opId: input.opId, path: input.path });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const agentFilesAnalyzeFeature: FeatureDefinition<
    typeof agentFilesAnalyze.command,
    typeof agentFilesAnalyze.input,
    typeof agentFilesAnalyze.output
> = defineFeature({
    ...agentFilesAnalyze,
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestFilesAnalyze(row.id, { opId: input.opId, path: input.path });
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const agentFilesSearchFeature: FeatureDefinition<
    typeof agentFilesSearch.command,
    typeof agentFilesSearch.input,
    typeof agentFilesSearch.output
> = defineFeature({
    ...agentFilesSearch,
    access: { feature: 'devices', level: 'write' },
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

export const agentFilesMutateFeature: FeatureDefinition<
    typeof agentFilesMutate.command,
    typeof agentFilesMutate.input,
    typeof agentFilesMutate.output
> = defineFeature({
    ...agentFilesMutate,
    access: { feature: 'devices', level: 'write' },
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
            action: 'agent.filesMutate',
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
export const agentFilesDownloadFeature: FeatureDefinition<
    typeof agentFilesDownload.command,
    typeof agentFilesDownload.input,
    typeof agentFilesDownload.output
> = defineFeature({
    ...agentFilesDownload,
    access: { feature: 'devices', level: 'write' },
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
export const agentFilesUploadFeature: FeatureDefinition<
    typeof agentFilesUpload.command,
    typeof agentFilesUpload.input,
    typeof agentFilesUpload.output
> = defineFeature({
    ...agentFilesUpload,
    access: { feature: 'devices', level: 'write' },
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
                action: 'agent.filesUpload',
                description: `Téléversement : « ${row.name} » — ${input.path}`,
                metadata: { deviceId: row.id, ownerId: row.owner_id, path: input.path }
            });
        }
        return { ok: true };
    }
});
