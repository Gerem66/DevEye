import type { Logger } from 'pino';
import type {
    NotificationChannel,
    NotificationChannelKind,
    NotificationChannelRow,
    NotificationFeature
} from 'deveye-types';

import { decryptCredentials } from '@/features/mail/_shared';
import type { DiscordMessage } from '@/Services/discord';
import * as mailClient from '@/Services/MailAccountClient';
import type { Cipher } from '@/Services/SecureStore';
import type { Database } from '@/db';

/**
 * L'acheminement des alertes : résoudre les canaux d'une cible, puis livrer.
 *
 * ## Ce qui a changé, et pourquoi
 *
 * Ce module résolvait **deux** canaux — un mail, un webhook — lus dans une ligne
 * par couple `(espace, feature)`. Il en résout désormais une **liste**, tirée de
 * `notification_channels` par une route. Trois conséquences :
 *
 *  - une même destination sert plusieurs fonctionnalités sans être redéclarée ;
 *  - une fonctionnalité peut écrire à plusieurs endroits ;
 *  - un élément peut router ailleurs que sa fonctionnalité.
 *
 * ## Discord n'est plus deviné
 *
 * `webhookBody` reniflait l'URL pour décider entre les embeds et le texte. Ça
 * marchait, mais décidait à la place de l'utilisateur, et le commentaire de
 * `discord.ts` le reconnaissait déjà comme un pis-aller. C'est maintenant le
 * **type déclaré** du canal qui tranche. `isDiscordWebhook` survit, mais comme
 * contrôle de saisie : avertir que l'URL collée dans un canal « Discord » n'en
 * est pas une.
 */

/**
 * Un canal prêt à recevoir, tel que la livraison en a besoin.
 *
 * Un canal que rien ne rend exploitable — compte expéditeur disparu, désactivé
 * ou gardé, URL illisible — **n'apparaît pas** dans la liste résolue plutôt que
 * d'y figurer inerte. La livraison n'a ainsi jamais à revérifier ce que la
 * résolution a déjà tranché.
 */
export interface ResolvedChannel {
    id: number;
    kind: NotificationChannelKind;
    label: string;
    /** Renseigné sur un canal `email`, `null` sinon. */
    email: { to: string; credentials: mailClient.MailCredentials; fromEmail: string } | null;
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
 * Comment nommer un canal que personne n'a nommé.
 *
 * La reprise de la 087 laisse `label_enc` à NULL : aucune requête SQL ne peut
 * produire un cryptogramme, et y écrire du clair rendrait `tryDecrypt` nul à la
 * lecture. Retomber sur la **destination** est la meilleure description
 * possible — et, sur les doublons que la reprise crée forcément, c'est
 * précisément ce qui les donne à voir comme des doublons.
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
 * Un compte mail est-il réellement capable d'envoyer sans intervention ?
 *
 * Trois conditions, et l'interface a besoin de la réponse pour dire « ce canal
 * ne partira pas » plutôt que d'afficher un réglage qui ment : le compte doit
 * exister **dans cet espace**, être actif, et appartenir au palier « open » —
 * un compte gardé exige un déverrouillage que l'ordonnanceur de fond n'a jamais.
 */
async function readyMailAccount(
    db: Database,
    workspaceId: number,
    mailAccountId: number | null
): Promise<{ id: number; emailAddressEnc: string; credentialsEnc: string } | null> {
    if (!mailAccountId) return null;
    const account = await db.mailAccounts.findById(mailAccountId, workspaceId);
    if (!account || account.enabled !== 1 || account.security_tier !== 'open') return null;
    return { id: account.id, emailAddressEnc: account.email_address_enc, credentialsEnc: account.credentials_enc };
}

/**
 * Un canal tel que l'écran de réglages le montre.
 *
 * Distinct de {@link ResolvedChannel} exprès : celui-ci décrit, l'autre livre.
 * Un canal cassé doit **apparaître** dans la liste, accompagné de son `ready`
 * faux, pour qu'on puisse le réparer ; il doit **disparaître** de la livraison,
 * pour qu'on n'essaie pas de s'en servir. Une seule structure servirait mal les
 * deux besoins.
 */
export async function describeChannel(
    db: Database,
    cipher: Cipher,
    row: NotificationChannelRow,
    usageCount: number,
    /**
     * L'appelant a-t-il le droit de **lire la destination** ?
     *
     * Le libellé et l'état sortent toujours : il faut voir les destinations pour
     * router une fonctionnalité vers l'une d'elles. L'adresse, non — et c'est ce
     * qui permet de confier le réglage d'Uptime sans confier l'adresse de
     * l'astreinte ni l'URL du salon de production.
     */
    reveal: boolean
): Promise<NotificationChannel> {
    const { label, target } = await decodeChannel(cipher, row);
    const ready =
        row.kind === 'email' ? (await readyMailAccount(db, row.workspace_id, row.mail_account_id)) !== null : !!target;
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
async function resolveChannel(
    db: Database,
    cipher: Cipher,
    row: NotificationChannelRow
): Promise<ResolvedChannel | null> {
    if (row.enabled !== 1) return null;
    const { label, target } = await decodeChannel(cipher, row);

    if (row.kind === 'email') {
        const account = await readyMailAccount(db, row.workspace_id, row.mail_account_id);
        if (!account) return null;
        const accountEmail = await cipher.tryDecrypt(account.emailAddressEnc);
        if (!accountEmail) return null;
        // Destinataire vide = l'adresse du compte expéditeur lui-même, ce que
        // `notification_settings.email_enc IS NULL` voulait déjà dire.
        const to = target?.trim() || accountEmail;
        try {
            return {
                id: row.id,
                kind: row.kind,
                label,
                email: {
                    to,
                    credentials: await decryptCredentials(cipher, account.credentialsEnc),
                    fromEmail: accountEmail
                },
                webhookUrl: null
            };
        } catch {
            // Identifiants illisibles : pas d'expéditeur, et surtout pas
            // d'exception qui remonterait dans une boucle de fond.
            return null;
        }
    }

    if (!target) return null;
    return { id: row.id, kind: row.kind, label, email: null, webhookUrl: target };
}

/**
 * Les canaux d'une cible, **héritage compris**.
 *
 * La règle, dans cet ordre :
 *
 *  1. l'élément a une route → ce sont ses canaux, et **une route vide vaut le
 *     silence**. C'est ce que la présence d'une ligne exprime, et pourquoi la
 *     liaison vit dans sa propre table ;
 *  2. sinon → la route de sa fonctionnalité ;
 *  3. sinon → aucun canal.
 *
 * Rien n'est deviné : sans route enregistrée, rien ne part. C'est le défaut qui
 * compte — une fonctionnalité qui se met à écrire à des gens sans qu'ils
 * l'aient demandé est précisément ce qu'on corrige depuis la 075.
 */
export async function resolveRoute(
    db: Database,
    cipher: Cipher,
    workspaceId: number,
    feature: NotificationFeature,
    itemId?: number
): Promise<ResolvedChannel[]> {
    let route = itemId ? await db.notificationChannels.findRoute(workspaceId, feature, itemId) : null;
    if (!route) route = await db.notificationChannels.findRoute(workspaceId, feature, 0);
    if (!route) return [];

    const ids = await db.notificationChannels.routeChannelIds(route.id);
    if (ids.length === 0) return [];

    const rows = await db.notificationChannels.list(workspaceId, feature);
    const wanted = new Set(ids);
    const resolved = await Promise.all(rows.filter((r) => wanted.has(r.id)).map((r) => resolveChannel(db, cipher, r)));
    return resolved.filter((c): c is ResolvedChannel => c !== null);
}

/**
 * Résout des canaux **par identifiant**, sans passer par une route.
 *
 * L'essai d'un canal isolé n'a pas de route : il vise la ligne telle qu'elle est
 * enregistrée. C'est ce qui supprime le détour de l'ancien dialogue, qui devait
 * enregistrer avant de tester sous peine d'éprouver les réglages précédents.
 *
 * Les identifiants étrangers à l'espace tombent d'eux-mêmes : chaque ligne est
 * relue pour cet espace, et une absence ne résout rien. La feature n'entre pas
 * en jeu : on vise des lignes précises, quelle que soit leur propriétaire.
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
        rows.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => resolveChannel(db, cipher, r))
    );
    return resolved.filter((c): c is ResolvedChannel => c !== null);
}

/**
 * Date et heure dans le corps d'une alerte, en français.
 *
 * Ici et non dans l'émetteur : les cinq features écrivent des corps de message,
 * et une alerte de base horodatée autrement qu'une alerte de disponibilité
 * donnerait l'impression de venir d'un autre produit.
 */
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
    /**
     * La mise en page Discord de cette alerte, quand la feature en a une.
     *
     * Facultative : une feature qui n'en fournit pas garde le texte, y compris
     * sur un canal déclaré Discord — mieux vaut un message simple qu'aucun.
     */
    embeds?: DiscordMessage['embeds'];
}

/**
 * Tronqué sous la limite stricte de 2000 caractères de Discord, qui rejette le
 * message entier au-delà plutôt que de le couper.
 */
const WEBHOOK_TEXT_MAX = 1900;

/**
 * Un webhook refusé, expliqué : les mots du fournisseur valent mieux qu'« HTTP
 * 400 ». Discord dit « Cannot send an empty message », Slack nomme le champ
 * manquant ; le code seul n'a jamais permis de corriger une URL.
 */
async function webhookRejection(response: Response): Promise<string> {
    const detail = await response
        .text()
        .then((body) => body.slice(0, 200).trim())
        .catch(() => '');
    return detail ? `Le webhook a répondu ${response.status} : ${detail}` : `Le webhook a répondu ${response.status}`;
}

/**
 * La charge utile envoyée au webhook, **décidée par le type du canal**.
 *
 * Sur un canal `webhook`, charge utile à trois têtes : `content` pour Discord,
 * `text` pour Slack, les champs structurés pour un point d'entrée maison. Aucune
 * des trois ne gêne les autres, ce qui évite d'avoir à demander « quel
 * service ? » — c'est le canal générique, et il le reste.
 *
 * Sur un canal `discord` fourni d'embeds, `content` est **retiré** : le garder
 * afficherait deux fois la même alerte, le pavé de texte au-dessus de sa propre
 * mise en page. Sans embeds, Discord reçoit le texte comme n'importe qui.
 *
 * Séparée pour être vérifiable : le choix se juge sur l'objet rendu, sans réseau.
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
        try {
            await mailClient.sendMail(channel.email.credentials, {
                from: channel.email.fromEmail,
                to: [{ name: null, address: channel.email.to }],
                subject: alert.subject,
                text: alert.body
            });
            return true;
        } catch (e) {
            logger.error({ err: e instanceof Error ? e.message : String(e), channel: channel.id }, 'Alert mail failed');
            return false;
        }
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
 * Livre une alerte sur tous les canaux donnés, et dit si **au moins un** l'a
 * acceptée.
 *
 * Les canaux sont indépendants et livrés de front : un webhook en panne ne doit
 * ni supprimer le mail, ni retarder les autres, ni arrêter la boucle qui a
 * produit l'alerte. Chaque erreur est journalisée puis avalée.
 *
 * Le booléen n'est pas décoratif. Uptime marque son incident `notified` sur
 * cette réponse, et ne peut donc envoyer un « c'est revenu » que s'il a bien
 * envoyé le « c'est tombé » — sans quoi on recevrait un rétablissement sans
 * contexte. Un POST refusé n'est **pas** une livraison.
 */
export async function deliver(channels: ResolvedChannel[], alert: Alert, logger: Logger): Promise<boolean> {
    const results = await Promise.all(channels.map((c) => deliverOne(c, alert, logger)));
    return results.some(Boolean);
}

/**
 * Le squelette d'un envoi d'essai : refuse poliment s'il n'y a rien à joindre,
 * livre sinon.
 *
 * « Aucun canal activé » y est une **réponse**, pas une exception : l'écran
 * affiche la phrase telle quelle au lieu d'un « échec » qui laisserait croire à
 * une panne d'envoi.
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
