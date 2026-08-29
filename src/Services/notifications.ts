import type { Logger } from 'pino';
import type {
    NotificationChannel,
    NotificationChannelKind,
    NotificationChannelRow,
    NotificationFeature
} from '@deveye/types';

import { MAIL_TRANSPORT_PROVIDER, type MailTransportProvider } from '@deveye/types/sdk';

import type { DiscordMessage } from '@/Services/discord';
import type { Cipher } from '@/Services/SecureStore';
import type { Database } from '@/db';
import { moduleProvider } from '@/features/_sdk/register';

/**
 * L'acheminement des alertes : résoudre les canaux d'une cible (une liste tirée
 * de `notification_channels` par une route), puis livrer. Le type déclaré du
 * canal décide de la charge utile, jamais l'URL. Le courriel passe par le
 * contrat du module Mail (`MAIL_TRANSPORT_PROVIDER`) ; sans module, un canal
 * e-mail n'est jamais prêt.
 */

/**
 * Le transport des alertes e-mail, tel que le module Mail l'offre ; `undefined`
 * sans module. Relu à chaque appel : l'ordre du boot ne compte pas. Le cycle
 * d'import avec `facade.ts` est sans effet, rien n'est évalué au chargement.
 */
function mailTransport(): MailTransportProvider | undefined {
    return moduleProvider<MailTransportProvider>(MAIL_TRANSPORT_PROVIDER);
}

/**
 * Un canal prêt à recevoir, tel que la livraison en a besoin : un canal
 * inexploitable n'apparaît pas dans la liste résolue, la livraison n'a jamais
 * à revérifier.
 */
export interface ResolvedChannel {
    id: number;
    kind: NotificationChannelKind;
    label: string;
    /** Renseigné sur un canal `email`, `null` sinon : le destinataire, et le compte expéditeur du module Mail. */
    email: { to: string; accountId: number; workspaceId: number } | null;
    /** Renseigné sur un canal `webhook` ou `discord`, `null` sinon. */
    webhookUrl: string | null;
}

/** Un canal exploitable existe-t-il ? */
export function hasChannel(channels: ResolvedChannel[]): boolean {
    return channels.length > 0;
}

/** Les canaux Discord d'une liste résolue — ceux qui savent modifier leurs messages. */
export function discordChannels(channels: ResolvedChannel[]): ResolvedChannel[] {
    return channels.filter((c) => c.kind === 'discord' && c.webhookUrl !== null);
}

/**
 * Comment nommer un canal que personne n'a nommé : la destination est la
 * meilleure description possible.
 */
export function fallbackLabel(kind: NotificationChannelKind, target: string | null): string {
    if (kind === 'email') return target?.trim() || 'Compte expéditeur';
    if (!target) return kind === 'discord' ? 'Webhook Discord' : 'Webhook';
    try {
        const url = new URL(target);
        // Le chemin d'un webhook porte son secret : on n'en garde que la tête.
        const head = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
        return head ? `${url.hostname}/${head}` : url.hostname;
    } catch {
        return target.slice(0, 64);
    }
}

/** Le libellé et la cible d'une ligne, déchiffrés à l'étage ouvert. */
async function decodeChannel(
    cipher: Cipher,
    row: NotificationChannelRow
): Promise<{ label: string; target: string | null }> {
    const target = row.target_enc ? await cipher.tryDecrypt(row.target_enc) : null;
    const label = row.label_enc ? await cipher.tryDecrypt(row.label_enc) : null;
    return { label: label || fallbackLabel(row.kind, target), target };
}

/**
 * Un compte mail est-il réellement capable d'envoyer sans intervention ? Dans
 * cet espace, actif, et au palier ouvert (un compte gardé exige un
 * déverrouillage que l'ordonnanceur de fond n'a jamais). Sans module, personne.
 */
async function readyMailAccount(workspaceId: number, mailAccountId: number | null): Promise<boolean> {
    if (!mailAccountId) return false;
    return (await mailTransport()?.isReady(mailAccountId, workspaceId)) ?? false;
}

/**
 * Un canal tel que l'écran de réglages le montre. Distinct de
 * {@link ResolvedChannel} : un canal cassé doit apparaître ici avec `ready`
 * faux, pour qu'on le répare, et disparaître de la livraison.
 */
export async function describeChannel(
    cipher: Cipher,
    row: NotificationChannelRow,
    usageCount: number,
    /**
     * L'appelant a-t-il le droit de lire la destination ? Libellé et état
     * sortent toujours (il faut voir les destinations pour router) ; l'adresse, non.
     */
    reveal: boolean
): Promise<NotificationChannel> {
    const { label, target } = await decodeChannel(cipher, row);
    const ready = row.kind === 'email' ? await readyMailAccount(row.workspace_id, row.mail_account_id) : !!target;
    return {
        id: row.id,
        kind: row.kind,
        label,
        target: reveal ? (target ?? '') : '',
        mailAccountId: row.mail_account_id,
        ready,
        enabled: row.enabled === 1,
        position: row.position,
        usageCount
    };
}

/** Une ligne de canal, prête à livrer — ou `null` si rien ne peut en sortir. */
async function resolveChannel(cipher: Cipher, row: NotificationChannelRow): Promise<ResolvedChannel | null> {
    if (row.enabled !== 1) return null;
    const { label, target } = await decodeChannel(cipher, row);

    if (row.kind === 'email') {
        const transport = mailTransport();
        if (!transport || !row.mail_account_id) return null;
        // L'expéditeur tel que le module le liste : prêt, ou absent de la liste
        // et alors rien ne peut partir de ce canal.
        const senders = await transport.listSenders(row.workspace_id);
        const sender = senders.find((s) => s.id === row.mail_account_id);
        if (!sender) return null;
        // Destinataire vide = l'adresse du compte expéditeur lui-même.
        const to = target?.trim() || sender.address;
        return {
            id: row.id,
            kind: row.kind,
            label,
            email: { to, accountId: sender.id, workspaceId: row.workspace_id },
            webhookUrl: null
        };
    }

    if (!target) return null;
    return { id: row.id, kind: row.kind, label, email: null, webhookUrl: target };
}

/**
 * Les canaux d'une cible (un élément, ou la fonctionnalité elle-même pour un
 * émetteur sans éléments) : sa sélection, ou rien. Pas d'héritage, rien n'est
 * deviné : sans route enregistrée, rien ne part.
 */
export async function resolveRoute(
    db: Database,
    cipher: Cipher,
    workspaceId: number,
    feature: NotificationFeature,
    itemId?: number
): Promise<ResolvedChannel[]> {
    const route = await db.notificationChannels.findRoute(workspaceId, feature, itemId ?? 0);
    if (!route) return [];

    const ids = await db.notificationChannels.routeChannelIds(route.id);
    if (ids.length === 0) return [];

    const rows = await db.notificationChannels.list(workspaceId, feature);
    const wanted = new Set(ids);
    const resolved = await Promise.all(rows.filter((r) => wanted.has(r.id)).map((r) => resolveChannel(cipher, r)));
    return resolved.filter((c): c is ResolvedChannel => c !== null);
}

/**
 * Résout des canaux par identifiant, sans passer par une route (l'essai d'un
 * canal isolé). Les identifiants étrangers à l'espace tombent d'eux-mêmes :
 * chaque ligne est relue pour cet espace.
 */
export async function resolveChannelIds(
    db: Database,
    cipher: Cipher,
    workspaceId: number,
    ids: number[]
): Promise<ResolvedChannel[]> {
    if (ids.length === 0) return [];
    const rows = await Promise.all(ids.map((id) => db.notificationChannels.findById(id, workspaceId)));
    const resolved = await Promise.all(
        rows.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => resolveChannel(cipher, r))
    );
    return resolved.filter((c): c is ResolvedChannel => c !== null);
}

/** Date et heure dans le corps d'une alerte, en français, les mêmes pour tous les émetteurs. */
export function formatMoment(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** « 2 h 5 min », « 45 s » — une durée lisible dans un corps d'alerte. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

/** Ce qu'une alerte porte, indépendamment du canal qui la transporte. */
export interface Alert {
    subject: string;
    body: string;
    /**
     * Champs structurés du webhook, en plus de `content`/`text`. Permet à un
     * point d'entrée maison de filtrer sans analyser du texte.
     */
    payload: Record<string, unknown>;
    /** La mise en page Discord de cette alerte, quand la feature en a une ; sinon le texte. */
    embeds?: DiscordMessage['embeds'];
}

/**
 * Tronqué sous la limite stricte de 2000 caractères de Discord, qui rejette le
 * message entier au-delà plutôt que de le couper.
 */
const WEBHOOK_TEXT_MAX = 1900;

/** Un webhook refusé, expliqué : les mots du fournisseur valent mieux qu'« HTTP 400 ». */
async function webhookRejection(response: Response): Promise<string> {
    const detail = await response
        .text()
        .then((body) => body.slice(0, 200).trim())
        .catch(() => '');
    return detail ? `Le webhook a répondu ${response.status} : ${detail}` : `Le webhook a répondu ${response.status}`;
}

/**
 * La charge utile envoyée au webhook, décidée par le type du canal. Sur un
 * canal `webhook`, trois têtes : `content` pour Discord, `text` pour Slack, les
 * champs structurés pour un point d'entrée maison. Sur un canal `discord`
 * fourni d'embeds, `content` est retiré : le garder afficherait l'alerte deux fois.
 */
export function webhookBody(kind: NotificationChannelKind, alert: Alert): Record<string, unknown> {
    const text = alert.body.slice(0, WEBHOOK_TEXT_MAX);
    if (kind === 'discord' && alert.embeds && alert.embeds.length > 0) {
        return { embeds: alert.embeds, ...alert.payload };
    }
    return { content: text, text, ...alert.payload };
}

/** Livre une alerte sur un seul canal, et dit s'il l'a acceptée. */
async function deliverOne(channel: ResolvedChannel, alert: Alert, logger: Logger): Promise<boolean> {
    if (channel.email) {
        // Le module Mail ne lève jamais, il répond. Sans module (retiré entre
        // la résolution et la livraison), rien ne part.
        const transport = mailTransport();
        if (!transport) return false;
        const sent = await transport.send(channel.email.accountId, channel.email.workspaceId, {
            to: channel.email.to,
            subject: alert.subject,
            text: alert.body
        });
        if (!sent) logger.warn({ channel: channel.id }, 'Alert mail refused by the mail transport');
        return sent;
    }

    if (!channel.webhookUrl) return false;
    try {
        const response = await fetch(channel.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify(webhookBody(channel.kind, alert))
        });
        if (response.ok) return true;
        logger.warn({ reason: await webhookRejection(response), channel: channel.id }, 'Alert webhook rejected');
        return false;
    } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e), channel: channel.id }, 'Alert webhook failed');
        return false;
    }
}

/**
 * Livre une alerte sur tous les canaux donnés, de front (un webhook en panne
 * ne retarde pas le mail), et dit si au moins un l'a accepté. Le booléen
 * compte : Uptime marque son incident `notified` dessus. Un POST refusé n'est
 * pas une livraison.
 */
export async function deliver(channels: ResolvedChannel[], alert: Alert, logger: Logger): Promise<boolean> {
    const results = await Promise.all(channels.map((c) => deliverOne(c, alert, logger)));
    return results.some(Boolean);
}

/**
 * Un envoi d'essai. « Aucun canal exploitable » est une réponse, pas une
 * exception : l'écran affiche la phrase telle quelle.
 */
export async function sendTest(
    channels: ResolvedChannel[],
    alert: Alert,
    logger: Logger
): Promise<{ sent: boolean; error: string | null }> {
    if (!hasChannel(channels)) {
        return { sent: false, error: 'Aucun canal exploitable (vérifiez le compte expéditeur ou l’URL).' };
    }
    const sent = await deliver(channels, alert, logger);
    return {
        sent,
        error: sent ? null : 'Aucun canal n’a accepté l’envoi — vérifiez le compte expéditeur et l’URL du webhook.'
    };
}
