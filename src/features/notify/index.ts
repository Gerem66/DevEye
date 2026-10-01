import type { NotificationFeature } from '@deveye/types';
import {
    SYSTEM_NOTIFICATION_INFO,
    SYSTEM_NOTIFICATION_TARGET,
    featureDescriptor,
    featureNotifiesItself,
    notifyChannelAdd,
    notifyChannelDelete,
    notifyChannelList,
    notifyChannelReorder,
    notifyChannelTest,
    notifyChannelUpdate,
    notifyChannelUsage,
    notifyRouteGet,
    notifyRouteSet,
    notifyRouteTest
} from '@deveye/types';

import { resolveChannelIds, sampleAlert, sendTest } from '@/Services/notifications';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import {
    assertChannelAccess,
    assertRouteAccess,
    createChannel,
    foreignChannels,
    getRoute,
    listChannels,
    resolveChannelsFor,
    setRoute,
    updateChannel
} from '../_notifications';

/**
 * Les canaux d'alerte, et les routes qui pointent dessus. Deux étages
 * d'autorisation : les canaux appartiennent à leur fonctionnalité (champ
 * `channels` du grant) ; les routes relèvent du droit d'écriture de la
 * fonctionnalité visée. La cible système, qui n'est pas une fonctionnalité,
 * revient à un admin propriétaire de l'espace. Aucun ne peut être déclaré dans
 * `access` : la fonctionnalité visée est une donnée d'entrée, chaque handler
 * la vérifie en première ligne (`assertChannelAccess`, `assertRouteAccess`).
 */

/** La fonctionnalité propriétaire d'un canal, ou `not_found`. */
async function channelFeatureOf(ctx: FeatureContext, id: number): Promise<NotificationFeature> {
    const row = await ctx.db.notificationChannels.findById(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Canal introuvable');
    return row.feature;
}

/**
 * L'intitulé d'un élément, pour que la confirmation de suppression d'un canal
 * nomme ce qui va cesser de prévenir. Un module nomme ses éléments lui-même
 * (entrée `items`). `null` n'est pas une erreur : un élément supprimé dont la
 * route a survécu est « une cible disparue ».
 */
async function itemLabelOf(ctx: FeatureContext, feature: NotificationFeature, itemId: number): Promise<string | null> {
    const items = moduleItems(feature, ctx.db);
    if (items) return items.labelOf(ctx.secure.open, String(itemId), ctx.workspaceId);
    return null;
}

/**
 * L'espace où vit un élément : le sien, ou celui qui le projette ici. Un
 * élément inconnu de la table de projections est chez lui.
 */
async function homeWorkspaceOf(ctx: FeatureContext, feature: NotificationFeature, itemId: number): Promise<number> {
    const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, feature, String(itemId));
    return share?.home_workspace_id ?? ctx.workspaceId;
}

/**
 * La liste s'ouvre avec la lecture de la fonctionnalité : on ne route pas vers
 * des destinations qu'on ne voit pas. La gestion des canaux garde leur contenu
 * (`listChannels` vide `target` pour qui ne l'a pas).
 */
const channelList = defineFeature({
    ...notifyChannelList,
    handler: async (ctx, input) => {
        assertRouteAccess(ctx, input.feature, 'read');
        return { channels: await listChannels(ctx, input.feature) };
    }
});

const channelAdd = defineFeature({
    ...notifyChannelAdd,
    mutates: true,
    handler: async (ctx, input) => {
        // La gestion des canaux de la fonctionnalité visée, qui emporte sa
        // lecture : on ne déclare pas de canal sur ce qu'on ne voit pas.
        assertChannelAccess(ctx, input.feature);
        const { feature, ...draft } = input;
        const channel = await createChannel(ctx, feature, draft);
        ctx.audit({
            action: 'notify.channelAdd',
            description: `Canal d’alerte « ${channel.label} » ajouté (${feature})`
        });
        return { channel };
    }
});

const channelUpdate = defineFeature({
    ...notifyChannelUpdate,
    mutates: true,
    handler: async (ctx, input) => {
        assertChannelAccess(ctx, await channelFeatureOf(ctx, input.id));
        const { id, enabled, ...rest } = input;
        const channel = await updateChannel(ctx, id, rest, enabled);
        ctx.audit({ action: 'notify.channelUpdate', description: `Canal d’alerte « ${channel.label} » modifié` });
        return { channel };
    }
});

const channelUsage = defineFeature({
    ...notifyChannelUsage,
    handler: async (ctx, input) => {
        assertChannelAccess(ctx, await channelFeatureOf(ctx, input.id));
        const rows = await ctx.db.notificationChannels.usageDetail(input.id, ctx.workspaceId);
        const routes = await Promise.all(
            rows.map(async (r) => ({
                feature: r.feature,
                itemId: r.itemId === 0 ? null : r.itemId,
                itemLabel: r.itemId === 0 ? null : await itemLabelOf(ctx, r.feature, r.itemId)
            }))
        );
        return { channelId: input.id, routes };
    }
});

const channelDelete = defineFeature({
    ...notifyChannelDelete,
    mutates: true,
    handler: async (ctx, input) => {
        assertChannelAccess(ctx, await channelFeatureOf(ctx, input.id));
        // Les liaisons partent en cascade ; une route laissée vide est sans
        // conséquence (vide ou absente, la cible est silencieuse).
        if (!(await ctx.db.notificationChannels.remove(input.id, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Canal introuvable');
        }
        ctx.audit({ action: 'notify.channelDelete', description: `Canal d’alerte #${input.id} supprimé` });
        return { ok: true as const };
    }
});

const channelReorder = defineFeature({
    ...notifyChannelReorder,
    mutates: true,
    handler: async (ctx, input) => {
        // Un réordonnancement vise en pratique la liste d'UNE fonctionnalité,
        // mais l'entrée ne le garantit pas : chaque fonctionnalité touchée doit
        // être gérée par l'appelant.
        const touched = new Set<NotificationFeature>();
        for (const id of input.ids) touched.add(await channelFeatureOf(ctx, id));
        for (const f of touched) assertChannelAccess(ctx, f);
        await ctx.db.notificationChannels.reorder(ctx.workspaceId, input.ids);
        return { ok: true as const };
    }
});

const channelTest = defineFeature({
    ...notifyChannelTest,
    handler: async (ctx, input) => {
        const row = await ctx.db.notificationChannels.findById(input.id, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Canal introuvable');
        assertChannelAccess(ctx, row.feature);
        const channels = await resolveChannelIds(ctx.db, ctx.secure.open, ctx.workspaceId, [row.id]);
        return sendTest(channels, sampleAlert(channels[0]?.label ?? 'canal'), ctx.logger);
    }
});

const routeGet = defineFeature({
    ...notifyRouteGet,
    handler: async (ctx, input) => {
        assertRouteAccess(ctx, input.feature, 'read');
        // La route d'un élément projeté vit dans son espace d'origine : la lire
        // ici ferait croire qu'aucune alerte ne part. Ses destinations sont
        // rendues masquées (le genre, jamais l'adresse).
        const home = input.itemId ? await homeWorkspaceOf(ctx, input.feature, input.itemId) : ctx.workspaceId;
        const route = await getRoute(ctx, input.feature, input.itemId, home);
        const managedHere = home === ctx.workspaceId;
        const foreign = managedHere ? [] : await foreignChannels(ctx, home, input.feature, route.channelIds);
        return { route, foreign, managedHere, homeWorkspaceId: home };
    }
});

const routeSet = defineFeature({
    ...notifyRouteSet,
    mutates: true,
    handler: async (ctx, input) => {
        assertRouteAccess(ctx, input.feature, 'write');
        if (input.feature === SYSTEM_NOTIFICATION_TARGET && input.itemId !== undefined) {
            throw new FeatureError('validation', 'La cible système n’a pas d’éléments.');
        }
        // Router un élément projeté vers des canaux d'ici est refusé :
        // l'ordonnanceur qui sonde l'élément tourne dans son espace d'origine et
        // ne les résoudrait pas.
        if (input.itemId) {
            const home = await homeWorkspaceOf(ctx, input.feature, input.itemId);
            if (home !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Cet élément vient d’un autre espace : ses canaux se règlent depuis là-bas.'
                );
            }
        }
        // La sélection vit sur l'élément : une route de fonctionnalité n'existe
        // que pour ce qu'une fonctionnalité dit en son nom propre.
        if (
            input.feature !== SYSTEM_NOTIFICATION_TARGET &&
            input.itemId === undefined &&
            !featureNotifiesItself(featureDescriptor(input.feature))
        ) {
            throw new FeatureError(
                'validation',
                'Les canaux se choisissent sur chaque élément de cette fonctionnalité, dans ses réglages.'
            );
        }
        const route = await setRoute(ctx, input.feature, input.itemId, input.channelIds);
        ctx.audit({
            action: 'notify.routeSet',
            description: `Canaux de ${input.feature}${input.itemId ? ` #${input.itemId}` : ''} mis à jour`
        });
        return { route };
    }
});

const routeTest = defineFeature({
    ...notifyRouteTest,
    handler: async (ctx, input) => {
        // Un essai part réellement sur les canaux : c'est un envoi, pas une
        // lecture. Il relève donc du même droit que le réglage lui-même.
        assertRouteAccess(ctx, input.feature, 'write');
        const channels = await resolveChannelsFor(ctx, input.feature, input.itemId);
        const label = input.feature === SYSTEM_NOTIFICATION_TARGET ? SYSTEM_NOTIFICATION_INFO.label : input.feature;
        return sendTest(channels, sampleAlert(label), ctx.logger);
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const notifyFeatures: FeatureDefinition<string, any, any>[] = [
    channelList,
    channelAdd,
    channelUpdate,
    channelUsage,
    channelDelete,
    channelReorder,
    channelTest,
    routeGet,
    routeSet,
    routeTest
];
