import type { DeviceRow } from '@deveye/types';
import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import {
    devicesCancelDelete,
    devicesConfirm,
    devicesDelete,
    devicesForceDelete,
    devicesList,
    devicesRename,
    devicesReorder,
    devicesRequestDelete,
    devicesRevoke,
    devicesSetConfig
} from '../contracts/commands';
import type { DevicesRepo } from './repo';
import { computeAgentUpdate, loadHomeDevice, rowToDevice, toDevice, WRITE } from './_shared';

/**
 * La flotte de l'espace : la liste, le cycle de vie d'un appareil, son nom, sa
 * configuration de collecte et son rang. Tout relève du droit `devices: write`
 * de l'espace, doublé de la restriction par élément et du domicile que
 * `loadHomeDevice` applique. Les ordres au hub passent par la façade `agents`.
 */

export const devicesListFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesList.command,
    typeof devicesList.input,
    typeof devicesList.output
>({
    ...devicesList,
    handler: async (ctx) => {
        // Les appareils de l'espace actif : les siens et ceux qui y sont
        // projetés, dans le rang propre à cet espace. Un appareil masqué à ce
        // rôle disparaît de la liste plutôt que d'y figurer grisé.
        const rows: DeviceRow[] = await ctx.repo.devices.listVisible(ctx.workspaceId);
        const hidden = await ctx.items.restrictions();
        const visible = rows.filter((r) => hidden.get(r.id) !== 'none');
        const manifest = await ctx.deveye.agents.servedManifest();
        return {
            devices: visible.map((r) =>
                rowToDevice(
                    r,
                    ctx.deveye.devices.isOnline(r.id),
                    computeAgentUpdate(r, manifest),
                    r.workspace_id !== ctx.workspaceId,
                    ctx.quota.isPaused('agents', r.id)
                )
            )
        };
    }
});

/** Un appareil de plus en service : borné par l'offre du propriétaire de l'espace. */
function assertAgentQuota(ctx: SdkFeatureContext<DevicesRepo>): Promise<void> {
    return ctx.quota.assert('agents', async (owned) => (await ctx.repo.devices.countActiveInWorkspaces(owned)) + 1);
}

export const devicesConfirmFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesConfirm.command,
    typeof devicesConfirm.input,
    typeof devicesConfirm.output
>({
    ...devicesConfirm,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        // Un archivé n'a plus de jeton : l'activer ferait une fiche sans agent.
        if (row.status !== 'pending') {
            throw new FeatureError('conflict', 'Seul un appareil en attente d’approbation s’approuve');
        }
        await assertAgentQuota(ctx);
        // L'agent n'est pas connecté (la socket refuse un appareil en attente) :
        // il est admis à sa prochaine tentative.
        await ctx.repo.devices.setStatus(row.id, 'active');
        const updated = (await ctx.repo.devices.findById(row.id)) ?? { ...row, status: 'active' as const };
        ctx.audit({
            action: 'devices.confirm',
            level: 'warning',
            description: `Appareil approuvé : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesRevokeFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesRevoke.command,
    typeof devicesRevoke.input,
    typeof devicesRevoke.output
>({
    ...devicesRevoke,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        if (row.status === 'archived') throw new FeatureError('conflict', 'Appareil déjà archivé');
        // Unilatéral et immédiat, là où `requestDelete` demande à l'agent de
        // s'effacer : le jeton tombe, la session aussi, et seul un nouvel
        // appairage fait revenir la machine.
        await ctx.repo.devices.archive(row.id);
        ctx.deveye.agents.disconnectAgent(row.id);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? { ...row, status: 'archived' as const };
        ctx.audit({
            action: 'devices.revoke',
            level: 'warning',
            description: `Appareil révoqué et archivé : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesRenameFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesRename.command,
    typeof devicesRename.input,
    typeof devicesRename.output
>({
    ...devicesRename,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        await ctx.repo.devices.rename(row.id, input.name);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? { ...row, name: input.name };
        ctx.audit({
            action: 'devices.rename',
            description: `Appareil renommé : « ${row.name} » → « ${input.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

/**
 * Range les appareils de l'espace. Sous `devices: write` et non `admin: true` :
 * arranger la liste que son propre espace affiche n'est pas de la gestion de
 * flotte. Un appareil que l'espace ne voit pas est ignoré par la requête.
 */
export const devicesReorderFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesReorder.command,
    typeof devicesReorder.input,
    typeof devicesReorder.output
>({
    ...devicesReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Le rang appartient à l'espace qui regarde : sur la ligne pour les
        // appareils d'ici, sur la projection pour ceux qu'on ne fait que voir.
        const shares = await ctx.sharing.scope();
        const home = input.ids.filter((id) => !shares.foreignIds.has(id));
        await ctx.repo.devices.reorder(ctx.workspaceId, home);
        for (const [rank, id] of input.ids.entries()) {
            if (shares.foreignIds.has(id)) await ctx.sharing.setOrder(id, rank);
        }
        return { ids: input.ids };
    }
});

/**
 * Change la cadence de collecte, la conservation et les réglages du terminal
 * d'un appareil. Sous `devices: write` : c'est décider ce que le serveur
 * enregistre et garde, et sous quel compte une session s'ouvre.
 */
export const devicesSetConfigFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesSetConfig.command,
    typeof devicesSetConfig.input,
    typeof devicesSetConfig.output
>({
    ...devicesSetConfig,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        const { deviceId: _id, ...patch } = input;
        await ctx.repo.devices.setConfig(row.id, patch);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'devices.setConfig',
            description: `Configuration modifiée : « ${row.name} »`,
            metadata: { deviceId: row.id, ...patch }
        });
        // Une cadence ou un mode de capture changé se pousse à un agent en
        // ligne ; l'app recompose la config entière depuis la ligne écrite.
        if (input.metricIntervalSeconds !== undefined || input.processCapture !== undefined) {
            await ctx.deveye.agents.pushConfig(row.id);
        }
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesRequestDeleteFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesRequestDelete.command,
    typeof devicesRequestDelete.input,
    typeof devicesRequestDelete.output
>({
    ...devicesRequestDelete,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        if (row.status === 'archived' || row.status === 'pending_deletion') {
            throw new FeatureError('conflict', 'Device is already being deleted');
        }
        // Remember the current status so the deletion can be cancelled; an
        // offline agent receives the destroy signal on its next connection.
        await ctx.repo.devices.requestDeletion(row.id, row.status);
        const isOnline = ctx.deveye.agents.requestDestroy(row.id);
        ctx.audit({
            action: 'devices.requestDelete',
            level: 'warning',
            description: `Suppression demandée : « ${row.name} »${isOnline ? '' : ' (en attente de connexion)'}`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, online: isOnline }
        });
        const updated = (await ctx.repo.devices.findById(row.id)) ?? row;
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesCancelDeleteFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesCancelDelete.command,
    typeof devicesCancelDelete.input,
    typeof devicesCancelDelete.output
>({
    ...devicesCancelDelete,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        // Revenir actif, c'est reprendre une place de l'offre, comme une approbation.
        if ((row.status_before_delete ?? 'active') === 'active') await assertAgentQuota(ctx);
        await ctx.repo.devices.cancelDeletion(row.id);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'devices.cancelDelete',
            description: `Suppression annulée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesForceDeleteFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesForceDelete.command,
    typeof devicesForceDelete.input,
    typeof devicesForceDelete.output
>({
    ...devicesForceDelete,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        if (row.status === 'archived') {
            throw new FeatureError('conflict', 'Device is already archived');
        }
        await ctx.repo.devices.archive(row.id);
        // Comme pour la révocation : seule la fermeture arrête vraiment le flux.
        ctx.deveye.agents.disconnectAgent(row.id);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? row;
        ctx.audit({
            action: 'devices.forceDelete',
            level: 'warning',
            description: `Suppression forcée (archivé sans auto-destruction de l'agent) : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

/**
 * Purge dure : la ligne appareil et, par cascade, tout son historique, pour
 * tous les espaces. Ne demande pas à l'agent de s'auto-détruire
 * (`devices.requestDelete` le fait).
 */
export const devicesDeleteFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesDelete.command,
    typeof devicesDelete.input,
    typeof devicesDelete.output
>({
    ...devicesDelete,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await loadHomeDevice(ctx, input.deviceId);
        await ctx.repo.devices.delete(row.id);
        ctx.audit({
            action: 'devices.delete',
            level: 'warning',
            description: `Appareil et données supprimés : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { deviceId: row.id };
    }
});
