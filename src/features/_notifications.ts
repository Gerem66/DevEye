import {
    SYSTEM_NOTIFICATION_TARGET,
    type NotificationChannel,
    type NotificationChannelInput,
    type NotificationFeature,
    type NotificationRoute
} from '@deveye/types';

import { describeChannel, resolveRoute, type ResolvedChannel } from '@/Services/notifications';

import { FeatureError, type FeatureContext } from './_define';
import { isDiscordWebhook } from '@/Services/discord';
import { isAllowedOutboundUrl, OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';

/**
 * Les canaux d'alerte vus depuis un handler : la mécanique vit dans
 * `Services/notifications.ts`, que les boucles de fond appellent sans session.
 * L'étage ouvert, et pas le gardé : ces boucles relisent les canaux sans mot de
 * passe, un secret au palier gardé rendrait l'alerte muette (voir
 * `Docs/SECURITY_MODEL.md`).
 */

/**
 * La cible système n'est pas une fonctionnalité d'espace : aucun rôle ne la
 * porte. Un admin global la règle dans un espace qu'il possède, et c'est là
 * que `Services/systemAlerts.ts` va chercher sa route.
 */
function managesSystem(ctx: FeatureContext): boolean {
    return ctx.isAdmin && ctx.isOwner;
}

function assertManagesSystem(ctx: FeatureContext): void {
    if (!managesSystem(ctx)) {
        throw new FeatureError('forbidden', 'Réservé aux administrateurs, dans un espace qui leur appartient.');
    }
}

/**
 * Le droit de régler où une cible écrit : lire la fonctionnalité suffit pour
 * lire sa route (les canaux ne livrent pas leur adresse pour autant), l'écrire
 * pour la régler.
 */
export function assertRouteAccess(ctx: FeatureContext, feature: NotificationFeature, level: 'read' | 'write'): void {
    if (feature === SYSTEM_NOTIFICATION_TARGET) return assertManagesSystem(ctx);
    ctx.assertFeature(feature, level);
}

/** Le droit de déclarer, corriger ou supprimer les canaux d'une cible (champ `channels` du grant). */
export function assertChannelAccess(ctx: FeatureContext, feature: NotificationFeature): void {
    if (feature === SYSTEM_NOTIFICATION_TARGET) return assertManagesSystem(ctx);
    ctx.assertChannels(feature);
}

/** Les canaux d'une fonctionnalité, avec leur nombre d'usages, prêts pour l'écran. */
export async function listChannels(ctx: FeatureContext, feature: NotificationFeature): Promise<NotificationChannel[]> {
    const rows = await ctx.db.notificationChannels.list(ctx.workspaceId, feature);
    const usage = await ctx.db.notificationChannels.usageCounts(ctx.workspaceId);
    // La liste s'ouvre avec la fonctionnalité (on ne route pas vers ce qu'on ne
    // voit pas) ; les adresses restent derrière le grant `channels`.
    const reveal = feature === SYSTEM_NOTIFICATION_TARGET ? managesSystem(ctx) : ctx.canChannels(feature);
    return Promise.all(rows.map((row) => describeChannel(ctx.secure.open, row, usage.get(row.id) ?? 0, reveal)));
}

/**
 * Refus explicites plutôt que silencieux : un canal `email` sans compte
 * expéditeur ou un webhook sans URL valide produiraient une ligne qui paraît
 * réglée et ne part jamais.
 */
function validate(input: NotificationChannelInput): void {
    if (input.kind === 'email') {
        if (!input.mailAccountId) {
            throw new FeatureError('validation', 'Choisissez un compte expéditeur pour ce canal e-mail.');
        }
        return;
    }
    const url = input.target.trim();
    if (!url) throw new FeatureError('validation', 'Indiquez l’URL appelée en POST.');
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new FeatureError('validation', 'Cette URL est invalide.');
    }
    // `https` seulement : une alerte porte des noms de services, des messages
    // d'erreur et parfois des extraits de journal. Les laisser partir en clair
    // sur le réseau contredirait le chiffrement au repos qui les protège en base.
    if (parsed.protocol !== 'https:') {
        throw new FeatureError('validation', 'L’URL doit être en HTTPS.');
    }
    // Un webhook est un POST que le serveur émet sur ordre d'un membre, et dont
    // `notify.channelTest` rend l'issue : sans garde, c'est une sonde du réseau
    // de l'hôte.
    if (!isAllowedOutboundUrl(parsed)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
    if (input.kind === 'discord' && !isDiscordWebhook(url)) {
        throw new FeatureError(
            'validation',
            'Cette adresse n’est pas un webhook Discord (https://discord.com/api/webhooks/…). Pour un autre service, choisissez « Webhook ».'
        );
    }
}

/** Le libellé est chiffré comme la cible : il en dit autant sur l'organisation. */
async function encodeInput(ctx: FeatureContext, input: NotificationChannelInput, enabled: boolean) {
    validate(input);
    const target = input.target.trim();
    return {
        kind: input.kind,
        labelEnc: await ctx.secure.open.encrypt(input.label.trim()),
        targetEnc: target ? await ctx.secure.open.encrypt(target) : null,
        // Un compte expéditeur n'a de sens que sur un canal e-mail : le garder
        // sur un webhook laisserait une référence qui ne veut plus rien dire.
        mailAccountId: input.kind === 'email' ? input.mailAccountId : null,
        enabled
    };
}

export async function createChannel(
    ctx: FeatureContext,
    feature: NotificationFeature,
    input: NotificationChannelInput
): Promise<NotificationChannel> {
    const row = await ctx.db.notificationChannels.create(ctx.workspaceId, feature, await encodeInput(ctx, input, true));
    return describeChannel(ctx.secure.open, row, 0, true);
}

export async function updateChannel(
    ctx: FeatureContext,
    id: number,
    input: NotificationChannelInput,
    enabled: boolean
): Promise<NotificationChannel> {
    const row = await ctx.db.notificationChannels.update(id, ctx.workspaceId, await encodeInput(ctx, input, enabled));
    if (!row) throw new FeatureError('not_found', 'Canal introuvable');
    const usage = await ctx.db.notificationChannels.usageCounts(ctx.workspaceId);
    return describeChannel(ctx.secure.open, row, usage.get(row.id) ?? 0, true);
}

/**
 * La route d'une cible : sa sélection, ou rien (pas d'héritage). `itemId`
 * absent lit la route de la fonctionnalité elle-même (émetteurs sans éléments).
 */
export async function getRoute(
    ctx: FeatureContext,
    feature: NotificationFeature,
    itemId?: number,
    /**
     * L'espace où vit réellement l'élément, quand il est projeté depuis
     * ailleurs : ses canaux appartiennent à cet autre espace, les lire ici
     * ferait croire qu'aucune alerte ne part.
     */
    homeWorkspaceId?: number
): Promise<NotificationRoute> {
    const scope = homeWorkspaceId ?? ctx.workspaceId;
    const route = await ctx.db.notificationChannels.findRoute(scope, feature, itemId ?? 0);
    if (!route) return { channelIds: [] };
    return { channelIds: await ctx.db.notificationChannels.routeChannelIds(route.id) };
}

/**
 * Les canaux d'un autre espace, tels qu'un étranger peut les voir : leur
 * existence et leur type, ni libellé ni adresse. `usageCount: 0` et
 * `ready: false` : ces nombres parlent de l'espace d'origine.
 */
export async function foreignChannels(
    ctx: FeatureContext,
    homeWorkspaceId: number,
    feature: NotificationFeature,
    channelIds: number[]
): Promise<NotificationChannel[]> {
    if (channelIds.length === 0) return [];
    const wanted = new Set(channelIds);
    const rows = (await ctx.db.notificationChannels.list(homeWorkspaceId, feature)).filter((r) => wanted.has(r.id));
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: LABEL_OF[row.kind],
        target: '',
        mailAccountId: null,
        ready: false,
        enabled: row.enabled === 1,
        position: row.position,
        usageCount: 0
    }));
}

/** Le genre d'une destination, jamais son identité. */
const LABEL_OF: Record<NotificationChannel['kind'], string> = {
    email: 'Adresse e-mail d’un autre espace',
    webhook: 'Webhook d’un autre espace',
    discord: 'Salon Discord d’un autre espace'
};

/**
 * Écrit la sélection d'une cible. Une sélection vide efface la ligne : route
 * vide et route absente disent la même chose (le silence).
 */
export async function setRoute(
    ctx: FeatureContext,
    feature: NotificationFeature,
    itemId: number | undefined,
    channelIds: number[]
): Promise<NotificationRoute> {
    if (channelIds.length === 0) {
        await ctx.db.notificationChannels.clearRoute(ctx.workspaceId, feature, itemId ?? 0);
        return { channelIds: [] };
    }
    await ctx.db.notificationChannels.setRoute(ctx.workspaceId, feature, itemId ?? 0, channelIds);
    return getRoute(ctx, feature, itemId);
}

/** Les canaux exploitables d'une cible, héritage compris — pour un envoi d'essai. */
export function resolveChannelsFor(
    ctx: FeatureContext,
    feature: NotificationFeature,
    itemId?: number
): Promise<ResolvedChannel[]> {
    return resolveRoute(ctx.db, ctx.secure.open, ctx.workspaceId, feature, itemId);
}
