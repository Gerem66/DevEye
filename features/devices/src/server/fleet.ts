import type { DeviceRow } from '@deveye/types';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    devicesCancelDelete,
    devicesConfirm,
    devicesDelete,
    devicesForceDelete,
    devicesList,
    devicesReactivate,
    devicesRename,
    devicesReorder,
    devicesRequestDelete,
    devicesRevoke,
    devicesSetConfig,
    devicesSetWorkspaces,
    devicesWorkspaceList
} from '../contracts/commands';
import type { DevicesRepo } from './repo';
import { ADMIN, computeAgentUpdate, loadDevice, rowToDevice, toDevice, WRITE } from './_shared';

/**
 * La flotte : la liste, le cycle de vie d'un appareil, son nom, sa
 * configuration de collecte, son rang et son partage entre espaces. Les gestes
 * de flotte sont réservés à l'administrateur global (`ADMIN`) ; ranger et
 * régler la collecte relèvent du droit `devices: write`. Les ordres au hub
 * passent par la façade `agents`.
 */

export const devicesListFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesList.command,
    typeof devicesList.input,
    typeof devicesList.output
>({
    ...devicesList,
    handler: async (ctx, input) => {
        // Deux ensembles : les appareils que l'espace actif voit, et la flotte
        // entière pour l'administration. La portée est explicite plutôt que
        // déduite du rôle : un administrateur travaille aussi dans un espace
        // partagé. La portée d'espace vient de la façade, qui porte la règle et
        // son exception (l'espace personnel d'un administrateur voit toute la
        // flotte) ; les lignes entières se relisent ici, dans l'ordre rendu.
        let rows: DeviceRow[];
        if (input.scope === 'fleet') {
            if (!ctx.isAdmin) throw new FeatureError('forbidden', 'Réservé aux administrateurs');
            rows = await ctx.repo.devices.listAll();
        } else {
            const visible = await ctx.deveye.devices.list();
            rows = await ctx.repo.devices.findByIds(visible.map((d) => d.id));
        }
        const ids = rows.map((r) => r.id);
        // Chargement groupé : une requête par carte serait un N+1 sur la flotte.
        const [manifest, shares] = await Promise.all([
            ctx.deveye.agents.servedManifest(),
            ctx.repo.devices.workspaceIdsFor(ids)
        ]);
        return {
            devices: rows.map((r) =>
                rowToDevice(
                    r,
                    ctx.deveye.devices.isOnline(r.id),
                    computeAgentUpdate(r, manifest),
                    shares.get(r.id) ?? []
                )
            )
        };
    }
});

export const devicesConfirmFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesConfirm.command,
    typeof devicesConfirm.input,
    typeof devicesConfirm.output
>({
    ...devicesConfirm,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
        if (row.status === 'revoked') throw new FeatureError('conflict', 'Device is revoked');
        await ctx.repo.devices.setStatus(row.id, 'active');
        // Le statut vit aussi dans la session agent, figée à la connexion : sans
        // cette remise à zéro, un agent déjà connecté verrait sa télémétrie
        // jetée en silence.
        ctx.deveye.agents.resetAgentSession(row.id);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
        await ctx.repo.devices.setStatus(row.id, 'revoked');
        // La session agent porte un instantané du statut : sans cette coupure,
        // l'agent révoqué continuerait d'écrire jusqu'à sa prochaine reconnexion.
        ctx.deveye.agents.disconnectAgent(row.id);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? { ...row, status: 'revoked' as const };
        ctx.audit({
            action: 'devices.revoke',
            level: 'warning',
            description: `Appareil révoqué : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, updated) };
    }
});

export const devicesReactivateFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesReactivate.command,
    typeof devicesReactivate.input,
    typeof devicesReactivate.output
>({
    ...devicesReactivate,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
        if (row.status !== 'revoked') {
            throw new FeatureError('conflict', 'Only a revoked device can be reactivated');
        }
        await ctx.repo.devices.setStatus(row.id, 'active');
        ctx.deveye.agents.resetAgentSession(row.id);
        const updated = (await ctx.repo.devices.findById(row.id)) ?? { ...row, status: 'active' as const };
        ctx.audit({
            action: 'devices.reactivate',
            description: `Appareil réactivé : « ${row.name} »`,
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
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
        await ctx.repo.devices.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

/**
 * Change la cadence de collecte et la conservation d'un appareil. Sous
 * `devices: write` : c'est décider ce que le serveur enregistre et garde.
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
        const row = await loadDevice(ctx, input.deviceId);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
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

/**
 * Les espaces avec lesquels un appareil peut être partagé, et lesquels le sont.
 * Seuls les espaces partagés sont proposés : l'accueil personnel d'un
 * administrateur voit déjà toute la flotte. La seule commande qui énumère des
 * espaces dont l'appelant n'est pas membre, d'où `admin: true`.
 */
export const devicesWorkspaceListFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesWorkspaceList.command,
    typeof devicesWorkspaceList.input,
    typeof devicesWorkspaceList.output
>({
    ...devicesWorkspaceList,
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
        const [all, shared] = await Promise.all([
            ctx.deveye.workspaces.list(),
            ctx.repo.devices.workspaceIdsOf(row.id)
        ]);
        const sharedSet = new Set(shared);
        return {
            originWorkspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
            workspaces: all
                .filter((w) => w.kind === 'shared' || w.id === row.workspace_id)
                .map((w) => ({
                    id: w.id,
                    name: w.name,
                    kind: w.kind,
                    shared: sharedSet.has(w.id)
                }))
        };
    }
});

/**
 * Ouvre (ou ferme) l'accès à un appareil, espace par espace. Journalisé en
 * avertissement : c'est donner de quoi ouvrir un terminal dessus. L'espace
 * d'appairage est réintégré d'office : il porte l'unicité de l'empreinte.
 */
export const devicesSetWorkspacesFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesSetWorkspaces.command,
    typeof devicesSetWorkspaces.input,
    typeof devicesSetWorkspaces.output
>({
    ...devicesSetWorkspaces,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        const row = await loadDevice(ctx, input.deviceId);
        const known = new Set((await ctx.deveye.workspaces.list()).map((w) => w.id));
        const wanted = new Set(input.workspaceIds.filter((id) => known.has(id)));
        if (row.workspace_id !== null) wanted.add(Number(row.workspace_id));

        const before = new Set(await ctx.repo.devices.workspaceIdsOf(row.id));
        await ctx.repo.devices.setWorkspaces(row.id, [...wanted]);

        const added = [...wanted].filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !wanted.has(id));
        if (added.length > 0 || removed.length > 0) {
            ctx.audit({
                action: 'devices.setWorkspaces',
                level: 'warning',
                description: `Partage modifié : « ${row.name} », ${wanted.size} espace(s)`,
                metadata: { deviceId: row.id, added, removed, workspaceIds: [...wanted] }
            });
        }
        const updated = (await ctx.repo.devices.findById(row.id)) ?? row;
        return { device: await toDevice(ctx, updated) };
    }
});
