import type {
    NotificationChannel,
    NotificationChannelInput,
    NotificationFeature,
    NotificationRoute
} from 'deveye-types';

import { describeChannel, resolveRoute, type ResolvedChannel } from '@/Services/notifications';

import { FeatureError, type FeatureContext } from './_define';

/**
 * Les canaux d'alerte vus depuis un handler.
 *
 * Le module ne fait qu'une chose que `Services/notifications.ts` ne fait pas :
 * il connaît `ctx`, donc l'espace visé et le codec de son étage ouvert. Toute la
 * mécanique — déchiffrement, résolution, héritage — vit dans le service, parce
 * que les boucles de fond en ont besoin **sans session** et ne peuvent donc pas
 * passer par ici.
 *
 * L'étage ouvert, et pas le gardé : ce sont ces boucles qui relisent les canaux,
 * sans mot de passe. Un secret rangé au palier gardé y serait illisible et
 * l'alerte ne partirait jamais, en silence (voir `Docs/SECURITY_MODEL.md`).
 */

/** Les canaux d'une fonctionnalité, avec leur nombre d'usages, prêts pour l'écran. */
export async function listChannels(ctx: FeatureContext, feature: NotificationFeature): Promise<NotificationChannel[]> {
    const rows = await ctx.db.notificationChannels.list(ctx.workspaceId, feature);
    const usage = await ctx.db.notificationChannels.usageCounts(ctx.workspaceId);
    // La liste est ouverte à tout membre — on ne peut pas router vers des
    // destinations qu'on ne voit pas. Les adresses, elles, restent derrière la
    // capacité : voir « Astreinte · e-mail » suffit pour cocher une case.
    const reveal = ctx.can('workspace.notifications');
    return Promise.all(
        rows.map((row) => describeChannel(ctx.db, ctx.secure.open, row, usage.get(row.id) ?? 0, reveal))
    );
}

/**
 * Ce qu'une saisie de canal doit respecter, avant d'atteindre la base.
 *
 * Les trois refus sont explicites plutôt que silencieux : un canal `email` sans
 * compte expéditeur, un webhook sans URL ou une URL qui n'en est pas une
 * produiraient tous les trois une ligne qui **paraît** réglée et ne part jamais.
 * C'est exactement le mensonge d'écran que l'ancien dialogue laissait passer, et
 * qu'il ne signalait que dans Uptime.
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
}

/**
 * Chiffre puis écrit un canal.
 *
 * Le libellé passe par le chiffre comme la cible : il porte souvent le nom d'une
 * équipe ou d'un salon, ce qui en dit autant sur l'organisation que l'adresse
 * elle-même. Il n'y a pas de raison de le traiter autrement.
 */
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
    return describeChannel(ctx.db, ctx.secure.open, row, 0, true);
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
    return describeChannel(ctx.db, ctx.secure.open, row, usage.get(row.id) ?? 0, true);
}

/**
 * La route d'une cible, telle que l'écran la montre : sa sélection, ou rien.
 *
 * Pas d'héritage (092) : un élément sans route a une sélection vide, point.
 * `itemId` absent lit la route de la fonctionnalité elle-même — le cas des
 * émetteurs sans éléments (Sentinelle).
 */
export async function getRoute(
    ctx: FeatureContext,
    feature: NotificationFeature,
    itemId?: number,
    /**
     * L'espace où vit réellement l'élément.
     *
     * Différent de l'espace actif quand on regarde un élément **projeté depuis
     * ailleurs**. Ses canaux appartiennent alors à cet autre espace : les lire
     * ici donnerait une liste vide, et l'écran ferait croire qu'aucune alerte ne
     * part — alors qu'elles partent, vers des destinations qu'on n'a pas à
     * connaître. C'est le cas « relié à un mail inaccessible ».
     */
    homeWorkspaceId?: number
): Promise<NotificationRoute> {
    const scope = homeWorkspaceId ?? ctx.workspaceId;
    const route = await ctx.db.notificationChannels.findRoute(scope, feature, itemId ?? 0);
    if (!route) return { channelIds: [] };
    return { channelIds: await ctx.db.notificationChannels.routeChannelIds(route.id) };
}

/**
 * Les canaux d'un **autre** espace, tels qu'un étranger peut les voir.
 *
 * Ni leur libellé ni leur adresse : seulement leur existence et leur type. Un
 * membre qui regarde un élément projeté doit savoir qu'il prévient quelqu'un —
 * sans quoi il le re-réglerait par-dessus — sans apprendre qui.
 *
 * Ils sont rendus avec `usageCount: 0` et `ready: false` : ces deux nombres
 * parlent de l'espace d'origine, et les recopier ici les ferait lire comme des
 * chiffres locaux.
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
 * Écrit la sélection d'une cible.
 *
 * Une sélection **vide** efface la ligne : depuis la 092, une route vide et une
 * route absente disent la même chose (le silence), et garder des lignes mortes
 * ne ferait que compter des fantômes dans « utilisé par N ».
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
