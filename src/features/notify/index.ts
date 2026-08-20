import type { NotificationFeature } from 'deveye-types';
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
} from 'deveye-types';

import { formatMoment, resolveChannelIds, sendTest } from '@/Services/notifications';

import {
    defineFeature,
    FeatureError,
    type FeatureAccessSpec,
    type FeatureContext,
    type FeatureDefinition
} from '../_define';
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
 * Les canaux d'alerte de l'espace, et les routes qui pointent dessus.
 *
 * ## Deux étages d'autorisation, et ils ne se confondent pas
 *
 * **Les canaux** appartiennent à l'espace : les gérer relève de
 * `workspace.notifications`, comme renommer l'espace relève de
 * `workspace.manage`. L'adresse de l'astreinte ou le salon de la production
 * n'ont pas à s'ouvrir parce qu'on a confié le réglage d'une fonctionnalité.
 *
 * **Les routes** relèvent de la fonctionnalité visée — `{ feature, level:
 * 'write' }`, résolu par commande depuis l'argument. Décider où Uptime écrit
 * fait partie du réglage d'Uptime.
 *
 * Cette seconde moitié ne peut pas être déclarée dans `access` : la
 * fonctionnalité visée est une **donnée d'entrée**, pas une constante de la
 * commande. Le dispatcheur ne peut donc pas la vérifier avant le handler, et
 * `assertRouteAccess` la vérifie en première ligne — le seul cas du module, et
 * la raison est la même que pour `device.setConfig` : le contrôle dépend de ce
 * qu'on touche.
 */

const MANAGE: FeatureAccessSpec = { capabilities: ['workspace.notifications'] };

/**
 * Le droit de régler où une fonctionnalité écrit.
 *
 * **Lecture** : le droit de lire la fonctionnalité suffit. Savoir vers quels
 * canaux elle pointe fait partie de la comprendre — et les canaux eux-mêmes ne
 * livrent pas leur adresse sans `workspace.notifications`.
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
 * ce qui va cesser de prévenir. Les quatre émetteurs à éléments rangent tous un
 * blob JSON chiffré à l'étage ouvert dont le nom est la première clé — la forme
 * est assez régulière pour une seule lecture générique, et assez peu pour
 * mériter le `switch` qui suit plutôt qu'un accès dynamique aux dépôts.
 *
 * `null` n'est pas une erreur : un élément supprimé dont la route a survécu est
 * exactement ce que l'écran doit montrer comme « une cible disparue ».
 */
async function itemLabelOf(ctx: FeatureContext, feature: NotificationFeature, itemId: number): Promise<string | null> {
    const content = await (async (): Promise<string | null> => {
        switch (feature) {
            case 'uptime':
                return (await ctx.db.uptimeServices.findById(itemId, ctx.workspaceId))?.content ?? null;
            case 'database':
                return (await ctx.db.databases.find(itemId, ctx.workspaceId))?.content ?? null;
            case 'deploy':
                return (await ctx.db.deploy.findTarget(itemId, ctx.workspaceId))?.content ?? null;
            case 'backup':
                return (await ctx.db.backup.findJob(itemId, ctx.workspaceId))?.content ?? null;
            case 'sentinel':
                // Sentinelle n'a pas d'éléments réglables : aucune route ne peut
                // porter un `item_id`, donc ce cas ne se produit pas.
                return null;
        }
    })();
    if (!content) return null;
    try {
        const raw = await ctx.secure.open.tryDecrypt(content);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { name?: string; title?: string };
        return parsed.name ?? parsed.title ?? null;
    } catch {
        return null;
    }
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
 * Volontairement **sans capacité** — comme `workspace.roleList`.
 *
 * On ne peut pas router une fonctionnalité vers des destinations qu'on ne voit
 * pas. Ce que la capacité garde, c'est le **contenu** des destinations :
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
    access: MANAGE,
    mutates: true,
    handler: async (ctx, input) => {
        // La capacité donne la gestion des destinations ; la feature
        // propriétaire doit au moins être lisible : on ne déclare pas de
        // canal sur une fonctionnalité qu'on ne voit pas.
        assertRouteAccess(ctx, input.feature, 'read');
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
    access: MANAGE,
    mutates: true,
    handler: async (ctx, input) => {
        const { id, enabled, ...rest } = input;
        const channel = await updateChannel(ctx, id, rest, enabled);
        ctx.audit({ action: 'notify.channelUpdate', description: `Canal d’alerte « ${channel.label} » modifié` });
        return { channel };
    }
});

const channelUsage = defineFeature({
    ...notifyChannelUsage,
    access: MANAGE,
    handler: async (ctx, input) => {
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
    access: MANAGE,
    mutates: true,
    handler: async (ctx, input) => {
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
    access: MANAGE,
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.notificationChannels.reorder(ctx.workspaceId, input.ids);
        return { ok: true as const };
    }
});

const channelTest = defineFeature({
    ...notifyChannelTest,
    access: MANAGE,
    handler: async (ctx, input) => {
        const row = await ctx.db.notificationChannels.findById(input.id, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Canal introuvable');
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
        return { route, foreign, managedHere };
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
