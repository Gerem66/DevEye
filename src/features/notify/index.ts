import type { NotificationFeature } from '@deveye/types';
import {
    featureDescriptor,
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

import { formatMoment, resolveChannelIds, sendTest } from '@/Services/notifications';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import {
    createChannel,
    foreignChannels,
    getRoute,
    listChannels,
    resolveChannelsFor,
    setRoute,
    updateChannel
} from '../_notifications';

/**
 * Les canaux d'alerte, et les routes qui pointent dessus.
 *
 * ## Deux étages d'autorisation, et ils ne se confondent pas
 *
 * **Les canaux** appartiennent à leur fonctionnalité (091) : les gérer relève
 * du champ `channels` du grant de rôle sur CETTE fonctionnalité
 * (`ctx.assertChannels`, migration 093). L'adresse de l'astreinte d'Uptime ne
 * s'ouvre ni parce qu'on a confié le réglage d'Uptime, ni parce qu'on gère les
 * canaux des sauvegardes.
 *
 * **Les routes** relèvent de la fonctionnalité visée — `{ feature, level:
 * 'write' }`, résolu par commande depuis l'argument. Décider où Uptime écrit
 * fait partie du réglage d'Uptime.
 *
 * Aucun de ces contrôles ne peut être déclaré dans `access` : la fonctionnalité
 * visée est une **donnée d'entrée** (l'argument `feature`, ou celle du canal
 * visé par son id), pas une constante de la commande. Le dispatcheur ne peut
 * donc pas la vérifier avant le handler ; chaque handler la vérifie en première
 * ligne, pour la même raison que `devices.setConfig` : le contrôle dépend de ce
 * qu'on touche.
 */

/** La fonctionnalité propriétaire d'un canal, ou `not_found`. */
async function channelFeatureOf(ctx: FeatureContext, id: number): Promise<NotificationFeature> {
    const row = await ctx.db.notificationChannels.findById(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Canal introuvable');
    return row.feature;
}

/**
 * Le droit de régler où une fonctionnalité écrit.
 *
 * **Lecture** : le droit de lire la fonctionnalité suffit. Savoir vers quels
 * canaux elle pointe fait partie de la comprendre — et les canaux eux-mêmes ne
 * livrent pas leur adresse sans la gestion des canaux de la fonctionnalité.
 *
 * **Écriture** : le droit d'écriture de la fonctionnalité. Régler où Uptime
 * prévient est un réglage d'Uptime, ni plus ni moins — l'étage de « droits
 * fins » qui distinguait le routage de l'écriture a été essayé puis retiré.
 *
 * Vérifié ici et non déclaré dans `access` : la fonctionnalité visée est une
 * **donnée d'entrée**, que le dispatcheur ne connaît pas avant le handler.
 */
function assertRouteAccess(ctx: FeatureContext, feature: NotificationFeature, level: 'read' | 'write'): void {
    ctx.assertFeature(feature, level === 'write' ? 'write' : 'read');
}

/**
 * L'intitulé d'un élément, relu au moment de l'affichage.
 *
 * Sert à une seule chose : que la confirmation de suppression d'un canal nomme
 * ce qui va cesser de prévenir. Un module nomme ses éléments lui-même (entrée
 * `items` de son serveur, le nom déchiffré par le codec ouvert de l'espace
 * appelant) ; plus aucun émetteur natif n'a d'éléments depuis le rapatriement
 * des dernières features à éléments, et le `switch` qui lisait leurs blobs a
 * disparu avec elles.
 *
 * `null` n'est pas une erreur : un élément supprimé dont la route a survécu est
 * exactement ce que l'écran doit montrer comme « une cible disparue », et un
 * module externe dont les éléments ne sont pas lisibles d'ici garde une
 * confirmation générique.
 */
async function itemLabelOf(ctx: FeatureContext, feature: NotificationFeature, itemId: number): Promise<string | null> {
    const items = moduleItems(feature, ctx.db);
    if (items) return items.labelOf(ctx.secure.open, itemId, ctx.workspaceId);
    return null;
}

/**
 * L'espace où vit un élément — le sien, ou celui qui le projette ici.
 *
 * `ctx.workspaceId` par défaut : un élément inconnu de la table de projections
 * est chez lui, et les commandes qui le visent échoueront de toute façon plus
 * loin sur son absence.
 */
async function homeWorkspaceOf(ctx: FeatureContext, feature: NotificationFeature, itemId: number): Promise<number> {
    const share = await ctx.db.itemSharing.findShare(ctx.workspaceId, feature, itemId);
    return share?.home_workspace_id ?? ctx.workspaceId;
}

/** L'alerte d'exemple, la même pour tous les essais. */
function testAlert(label: string) {
    const now = Math.floor(Date.now() / 1000);
    return {
        subject: `DevEye — essai de notification (${label})`,
        body: `Ceci est un envoi d’essai émis depuis DevEye le ${formatMoment(now)}.\n\nSi vous lisez ce message, ce canal fonctionne.`,
        payload: { event: 'test', label, at: now },
        embeds: [
            {
                title: 'Essai de notification',
                description: `Ce canal (**${label}**) est correctement relié à DevEye.`,
                color: 0x5865f2,
                timestamp: new Date(now * 1000).toISOString(),
                footer: { text: 'DevEye · essai' }
            }
        ]
    };
}

/**
 * La liste s'ouvre avec la lecture de la fonctionnalité, rien de plus.
 *
 * On ne peut pas router une fonctionnalité vers des destinations qu'on ne voit
 * pas. Ce que la gestion des canaux garde, c'est leur **contenu** :
 * `listChannels` vide `target` pour qui ne l'a pas, si bien qu'un membre voit
 * « Astreinte · e-mail », peut y router, et ne peut ni lire l'adresse ni la
 * modifier.
 */
const channelList = defineFeature({
    ...notifyChannelList,
    handler: async (ctx, input) => {
        // Les canaux d'une feature se lisent avec elle (091) : voir ceux
        // d'Uptime fait partie de lire Uptime, comme sa route.
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
        ctx.assertChannels(input.feature);
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
        ctx.assertChannels(await channelFeatureOf(ctx, input.id));
        const { id, enabled, ...rest } = input;
        const channel = await updateChannel(ctx, id, rest, enabled);
        ctx.audit({ action: 'notify.channelUpdate', description: `Canal d’alerte « ${channel.label} » modifié` });
        return { channel };
    }
});

const channelUsage = defineFeature({
    ...notifyChannelUsage,
    handler: async (ctx, input) => {
        ctx.assertChannels(await channelFeatureOf(ctx, input.id));
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
        ctx.assertChannels(await channelFeatureOf(ctx, input.id));
        // Les liaisons partent en cascade. Une route laissée vide reste, et
        // c'est sans conséquence depuis la 092 : vide ou absente, la cible est
        // silencieuse ; la prochaine sélection écrite la réutilise ou l'efface.
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
        for (const f of touched) ctx.assertChannels(f);
        await ctx.db.notificationChannels.reorder(ctx.workspaceId, input.ids);
        return { ok: true as const };
    }
});

const channelTest = defineFeature({
    ...notifyChannelTest,
    handler: async (ctx, input) => {
        const row = await ctx.db.notificationChannels.findById(input.id, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Canal introuvable');
        ctx.assertChannels(row.feature);
        const channels = await resolveChannelIds(ctx.db, ctx.secure.open, ctx.workspaceId, [row.id]);
        return sendTest(channels, testAlert(channels[0]?.label ?? 'canal'), ctx.logger);
    }
});

const routeGet = defineFeature({
    ...notifyRouteGet,
    handler: async (ctx, input) => {
        assertRouteAccess(ctx, input.feature, 'read');
        // La route d'un élément **projeté** vit dans son espace d'origine : la
        // lire ici rendrait une liste vide, et l'écran ferait croire qu'aucune
        // alerte ne part alors qu'elles partent — vers des destinations qu'on
        // n'a simplement pas à connaître.
        const home = input.itemId ? await homeWorkspaceOf(ctx, input.feature, input.itemId) : ctx.workspaceId;
        const route = await getRoute(ctx, input.feature, input.itemId, home);
        // Les destinations d'un élément projeté vivent dans son espace
        // d'origine : sans elles, l'écran afficherait « aucun canal » sur un
        // élément qui prévient bel et bien. Rendues masquées — le genre, jamais
        // l'adresse.
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
        // Router un élément **projeté** vers des canaux d'ici est refusé : ces
        // canaux appartiennent à cet espace, et l'ordonnanceur qui sonde
        // l'élément tourne dans le sien — il ne les résoudrait pas. Un écran qui
        // laisserait cocher produirait un réglage muet.
        if (input.itemId) {
            const home = await homeWorkspaceOf(ctx, input.feature, input.itemId);
            if (home !== ctx.workspaceId) {
                throw new FeatureError(
                    'forbidden',
                    'Cet élément vient d’un autre espace : ses canaux se règlent depuis là-bas.'
                );
            }
        }
        // La sélection vit sur l'élément (092) : une route de fonctionnalité ne
        // subsiste que pour les émetteurs sans éléments (Sentinelle). Sur les
        // autres, elle ne viserait rien de nommable.
        if (input.itemId === undefined && featureDescriptor(input.feature).hasItems) {
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
        return sendTest(channels, testAlert(input.feature), ctx.logger);
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
