import {
    deviceCancelDelete,
    deviceConfirm,
    deviceDelete,
    deviceForceDelete,
    deviceList,
    deviceReactivate,
    deviceRename,
    deviceReorder,
    deviceRequestDelete,
    deviceRevoke,
    deviceSetConfig,
    deviceSetWorkspaces,
    deviceWorkspaceList
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
        // Deux ensembles distincts : le plan de données (les appareils que
        // l'espace actif voit, ce qu'affichent l'accueil, la topbar et
        // Monitoring) et la flotte entière, qui n'a de sens que pour la page
        // d'administration. La portée est explicite plutôt que déduite du rôle :
        // un administrateur travaille lui aussi dans un espace partagé, et son
        // accueil n'y doit pas afficher les machines de tous les autres.
        //
        // Une exception, et une seule : son espace **personnel**, où toute la
        // flotte est disponible en permanence sans partage explicite. C'est là
        // qu'un administrateur surveille ses machines, et l'y obliger à se
        // partager à lui-même chaque appareil n'aurait rien protégé.
        // La garde est dans le handler et non déclarée : les deux portées
        // n'exigent pas le même droit, et un `access` unique en écraserait une.
        // Chaque appareil listé porte son rapport — posture de sécurité, ports
        // en écoute, inventaire matériel — donc l'appartenance à l'espace ne
        // suffit pas à le lire.
        let rows;
        if (input.scope === 'fleet') {
            ctx.assertAdmin();
            rows = await ctx.db.devices.listAll();
        } else if (ctx.isAdmin && ctx.workspace.kind === 'personal') {
            rows = await ctx.db.devices.listAll();
        } else {
            ctx.assertFeature('devices');
            rows = await ctx.db.devices.listByWorkspace(ctx.workspaceId);
        }
        const ids = rows.map((r) => r.id);
        const presence = online(ctx, ids);
        // Chargement groupé : une requête par carte serait un N+1 sur la page
        // Appareils, qui affiche la flotte entière.
        const [manifest, shares] = await Promise.all([
            readServedManifestCached(agentDistDir()),
            ctx.db.devices.workspaceIdsFor(ids)
        ]);
        return {
            devices: rows.map((r) =>
                deviceRowToDevice(r, presence[r.id] ?? false, computeAgentUpdate(r, manifest), shares.get(r.id) ?? [])
            )
        };
    }
});

export const deviceConfirmFeature: FeatureDefinition<
    typeof deviceConfirm.command,
    typeof deviceConfirm.input,
    typeof deviceConfirm.output
> = defineFeature({
    ...deviceConfirm,
    mutates: true,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status === 'revoked') throw new FeatureError('conflict', 'Device is revoked');
        await ctx.db.devices.setStatus(row.id, 'active');
        // Le statut vit aussi dans la session agent, figée à la connexion : sans
        // cette remise à zéro, un agent déjà connecté au moment de l'approbation
        // verrait sa télémétrie accusée puis jetée, indéfiniment et en silence.
        ctx.monitor?.resetAgentSession(row.id);
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
    mutates: true,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        await ctx.db.devices.setStatus(row.id, 'revoked');
        // La session agent porte un instantané du statut pris à la connexion, et
        // le filtre d'ingestion le relit tel quel : sans cette coupure, l'agent
        // révoqué continuerait d'écrire jusqu'à sa prochaine reconnexion — qui
        // peut ne jamais venir. Sa reconnexion, elle, sera refusée.
        ctx.monitor?.disconnectAgent(row.id);
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
    mutates: true,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        if (row.status !== 'revoked') {
            throw new FeatureError('conflict', 'Only a revoked device can be reactivated');
        }
        await ctx.db.devices.setStatus(row.id, 'active');
        ctx.monitor?.resetAgentSession(row.id);
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
    mutates: true,
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

/**
 * Range les appareils de l'espace.
 *
 * Sous `devices: write` et non `admin: true` comme le reste de ce module :
 * arranger la liste que son propre espace affiche n'est pas de la gestion de
 * flotte, et un membre qui peut piloter ses machines doit pouvoir les ranger.
 * Aucun état d'agent n'est touché.
 */
export const deviceReorderFeature: FeatureDefinition<
    typeof deviceReorder.command,
    typeof deviceReorder.input,
    typeof deviceReorder.output
> = defineFeature({
    ...deviceReorder,
    mutates: true,
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        await ctx.db.devices.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

/**
 * Change la cadence de collecte et la conservation d'un appareil.
 *
 * Sous `devices: write` : régler la collecte d'une machine, c'est décider ce que
 * le serveur enregistre d'elle et combien de temps il le garde — un membre qui
 * ne peut pas piloter les appareils de son espace n'a pas à en décider.
 */
export const deviceSetConfigFeature: FeatureDefinition<
    typeof deviceSetConfig.command,
    typeof deviceSetConfig.input,
    typeof deviceSetConfig.output
> = defineFeature({
    ...deviceSetConfig,
    mutates: true,
    access: { feature: 'devices', level: 'write' },
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
    mutates: true,
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
    mutates: true,
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
    mutates: true,
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
        // Même raison que pour la révocation : le statut est instantané côté
        // session agent, seule la fermeture arrête vraiment le flux.
        ctx.monitor?.disconnectAgent(row.id);
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

/**
 * Purge dure : la ligne appareil et, par cascade, tout son historique.
 *
 * Sous `admin: true` comme le reste de la gestion de flotte. Ce n'est pas une
 * action d'espace : elle détruit une machine et sa supervision pour **tous** les
 * espaces avec lesquels elle est partagée, définitivement.
 */
export const deviceDeleteFeature: FeatureDefinition<
    typeof deviceDelete.command,
    typeof deviceDelete.input,
    typeof deviceDelete.output
> = defineFeature({
    ...deviceDelete,
    mutates: true,
    access: { admin: true },
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

/**
 * Les espaces avec lesquels un appareil peut être partagé, et lesquels le sont.
 *
 * Seuls les espaces **partagés** sont proposés : ranger la machine d'autrui dans
 * l'espace personnel d'un tiers n'aurait pas de sens, et l'accueil personnel
 * d'un administrateur voit déjà toute la flotte sans partage (`device.list`).
 *
 * C'est la seule commande qui énumère des espaces dont l'appelant n'est pas
 * membre — d'où `admin: true`, et rien de plus que l'identité et le nom.
 */
export const deviceWorkspaceListFeature: FeatureDefinition<
    typeof deviceWorkspaceList.command,
    typeof deviceWorkspaceList.input,
    typeof deviceWorkspaceList.output
> = defineFeature({
    ...deviceWorkspaceList,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        const [all, shared] = await Promise.all([ctx.db.workspaces.listAll(), ctx.db.devices.workspaceIdsOf(row.id)]);
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
 * Ouvre (ou ferme) l'accès à un appareil, espace par espace.
 *
 * Journalisé en avertissement : donner accès à une machine, c'est donner à ses
 * membres de quoi ouvrir un terminal dessus. L'espace d'appairage est réintégré
 * d'office — le retirer laisserait un appareil dont plus personne ne répond de
 * l'origine, alors qu'il porte encore l'unicité de son empreinte.
 */
export const deviceSetWorkspacesFeature: FeatureDefinition<
    typeof deviceSetWorkspaces.command,
    typeof deviceSetWorkspaces.input,
    typeof deviceSetWorkspaces.output
> = defineFeature({
    ...deviceSetWorkspaces,
    mutates: true,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeDevice(ctx, input.deviceId);
        const known = new Set((await ctx.db.workspaces.listAll()).map((w) => w.id));
        const wanted = new Set(input.workspaceIds.filter((id) => known.has(id)));
        if (row.workspace_id !== null) wanted.add(Number(row.workspace_id));

        const before = new Set(await ctx.db.devices.workspaceIdsOf(row.id));
        await ctx.db.devices.setWorkspaces(row.id, [...wanted]);

        const added = [...wanted].filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !wanted.has(id));
        if (added.length > 0 || removed.length > 0) {
            ctx.audit({
                action: 'device.setWorkspaces',
                level: 'warning',
                description: `Partage modifié : « ${row.name} » — ${wanted.size} espace(s)`,
                metadata: { deviceId: row.id, added, removed, workspaceIds: [...wanted] }
            });
        }
        const updated = (await ctx.db.devices.findById(row.id)) ?? row;
        return { device: await toDevice(ctx, updated) };
    }
});
