import {
    deviceCancelDelete,
    deviceConfirm,
    deviceDelete,
    deviceForceDelete,
    deviceList,
    deviceReactivate,
    deviceRename,
    deviceRequestDelete,
    deviceRevoke,
    deviceSetConfig
} from 'deveye-types';

import { computeAgentUpdate, deviceAgentConfig, deviceRowToDevice } from '@/agent/mappers';
import { agentDistDir, readServedManifestCached } from '@/agent/sync';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeDevice, online, toDevice } from './shared';

/** Enrollment + status lifecycle of a device (the Appareils page actions). */

export const deviceListFeature: FeatureDefinition<
    typeof deviceList.command,
    typeof deviceList.input,
    typeof deviceList.output
> = defineFeature({
    ...deviceList,
    handler: async (ctx, input) => {
        // Deux ensembles distincts : le plan de données (les appareils de
        // l'espace actif, ce que voient l'accueil, la topbar et Monitoring) et la
        // flotte entière, qui n'a de sens que pour la page d'administration.
        // La portée est explicite plutôt que déduite du rôle : un administrateur
        // travaille lui aussi dans un espace, et son accueil ne doit pas afficher
        // les machines de tous les autres.
        let rows;
        if (input.scope === 'fleet') {
            ctx.assertAdmin();
            rows = await ctx.db.devices.listAll();
        } else {
            rows = await ctx.db.devices.listByWorkspace(ctx.workspaceId);
        }
        const presence = online(
            ctx,
            rows.map((r) => r.id)
        );
        const manifest = await readServedManifestCached(agentDistDir());
        return {
            devices: rows.map((r) => deviceRowToDevice(r, presence[r.id] ?? false, computeAgentUpdate(r, manifest)))
        };
    }
});

export const deviceConfirmFeature: FeatureDefinition<
    typeof deviceConfirm.command,
    typeof deviceConfirm.input,
    typeof deviceConfirm.output
> = defineFeature({
    ...deviceConfirm,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status === 'revoked') throw new FeatureError('conflict', 'Device is revoked');
        await ctx.db.devices.setStatus(row.id, 'active');
        const updated = await ctx.db.devices.findById(row.id);
        ctx.audit({
            action: 'device.confirm',
            level: 'warning',
            description: `Appareil approuvé : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated ?? { ...row, status: 'active' }) };
    }
});

export const deviceRevokeFeature: FeatureDefinition<
    typeof deviceRevoke.command,
    typeof deviceRevoke.input,
    typeof deviceRevoke.output
> = defineFeature({
    ...deviceRevoke,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.setStatus(row.id, 'revoked');
        const updated = await ctx.db.devices.findById(row.id);
        ctx.audit({
            action: 'device.revoke',
            level: 'warning',
            description: `Appareil révoqué : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated ?? { ...row, status: 'revoked' }) };
    }
});

export const deviceReactivateFeature: FeatureDefinition<
    typeof deviceReactivate.command,
    typeof deviceReactivate.input,
    typeof deviceReactivate.output
> = defineFeature({
    ...deviceReactivate,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status !== 'revoked') {
            throw new FeatureError('conflict', 'Only a revoked device can be reactivated');
        }
        await ctx.db.devices.setStatus(row.id, 'active');
        const updated = (await ctx.db.devices.findById(row.id)) ?? { ...row, status: 'active' as const };
        ctx.audit({
            action: 'device.reactivate',
            description: `Appareil réactivé : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const deviceRenameFeature: FeatureDefinition<
    typeof deviceRename.command,
    typeof deviceRename.input,
    typeof deviceRename.output
> = defineFeature({
    ...deviceRename,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.rename(row.id, input.name);
        const updated = await ctx.db.devices.findById(row.id);
        ctx.audit({
            action: 'device.rename',
            description: `Appareil renommé : « ${row.name} » → « ${input.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated ?? { ...row, name: input.name }) };
    }
});

export const deviceSetConfigFeature: FeatureDefinition<
    typeof deviceSetConfig.command,
    typeof deviceSetConfig.input,
    typeof deviceSetConfig.output
> = defineFeature({
    ...deviceSetConfig,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        const { deviceId: _id, ...patch } = input;
        await ctx.db.devices.setConfig(row.id, patch);
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'device.setConfig',
            description: `Configuration modifiée : « ${row.name} »`,
            metadata: { deviceId: row.id, ...patch }
        });
        // If a cadence or the capture mode changed, push it to a live agent.
        if (input.metricIntervalSeconds !== undefined || input.processCapture !== undefined) {
            ctx.monitor?.pushConfig(row.id, deviceAgentConfig(updated));
        }
        return { device: await toDevice(ctx, updated) };
    }
});

export const deviceRequestDeleteFeature: FeatureDefinition<
    typeof deviceRequestDelete.command,
    typeof deviceRequestDelete.input,
    typeof deviceRequestDelete.output
> = defineFeature({
    ...deviceRequestDelete,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status === 'archived' || row.status === 'pending_deletion') {
            throw new FeatureError('conflict', 'Device is already being deleted');
        }
        // Remember the current status so the deletion can be cancelled, then ask
        // a connected agent to self-destruct now; an offline agent receives the
        // destroy signal on its next connection (see agent/ws.ts).
        await ctx.db.devices.requestDeletion(row.id, row.status);
        const isOnline = ctx.monitor?.requestDestroy(row.id) ?? false;
        ctx.audit({
            action: 'device.requestDelete',
            level: 'warning',
            description: `Suppression demandée : « ${row.name} »${isOnline ? '' : ' (en attente de connexion)'}`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, online: isOnline }
        });
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        return { device: await toDevice(ctx, updated) };
    }
});

export const deviceCancelDeleteFeature: FeatureDefinition<
    typeof deviceCancelDelete.command,
    typeof deviceCancelDelete.input,
    typeof deviceCancelDelete.output
> = defineFeature({
    ...deviceCancelDelete,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.cancelDeletion(row.id);
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'device.cancelDelete',
            description: `Suppression annulée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const deviceForceDeleteFeature: FeatureDefinition<
    typeof deviceForceDelete.command,
    typeof deviceForceDelete.input,
    typeof deviceForceDelete.output
> = defineFeature({
    ...deviceForceDelete,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status === 'archived') {
            throw new FeatureError('conflict', 'Device is already archived');
        }
        // Archive immediately without telling the agent to self-destruct: this is
        // for agents that no longer exist (or that we don't care about cleaning).
        // A still-running agent is simply refused on its next connection.
        await ctx.db.devices.archive(row.id);
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'device.forceDelete',
            level: 'warning',
            description: `Suppression forcée (archivé sans auto-destruction de l'agent) : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const deviceDeleteFeature: FeatureDefinition<
    typeof deviceDelete.command,
    typeof deviceDelete.input,
    typeof deviceDelete.output
> = defineFeature({
    ...deviceDelete,
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        // Hard purge (used by the Monitoring page): removes the device row and,
        // by FK cascade, all its monitoring history. Does NOT self-destruct the
        // agent — that's `device.requestDelete` from the Appareils page.
        await ctx.db.devices.delete(row.id);
        ctx.audit({
            action: 'device.delete',
            level: 'warning',
            description: `Appareil et données supprimés : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { deviceId: row.id };
    }
});
