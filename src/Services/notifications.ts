import type { Logger } from 'pino';
import type { NotificationFeature } from 'deveye-types';

import { decryptCredentials } from '@/features/mail/_shared';
import { isDiscordWebhook } from '@/Services/discord';
import * as mailClient from '@/Services/MailAccountClient';
import type { Cipher } from '@/Services/SecureStore';
import type { Database } from '@/db';

/**
 * L'acheminement des alertes : résoudre les canaux d'un espace, puis livrer.
 *
 * Ce module existe parce que le même code d'envoi était écrit trois fois —
 * Uptime, Bases de données, Sentinelle — avec la même charge utile à trois têtes
 * et les mêmes précautions, recopiées. Trois copies d'une même quarantaine de
 * lignes, c'est trois occasions de corriger un bug à un seul endroit.
 *
 * Il n'avait d'abord absorbé que Sentinelle : Uptime et Bases de données ont
 * gardé leur copie longtemps après, ce qui laissait le module vrai en principe
 * et faux en pratique — il annonçait une mutualisation dont un seul appelant
 * bénéficiait. Les quatre émetteurs (Uptime, Sentinelle, Bases de données,
 * Déploiement) passent désormais par {@link deliver}, et c'est ce qui rend
 * l'affirmation ci-dessus vérifiable plutôt que déclarative.
 *
 * **Le mécanisme est commun, la configuration ne l'est pas** : `feature` désigne
 * la ligne de `notification_settings` à lire, et deux features ne se marchent
 * jamais dessus.
 */

export interface Channels {
    /** Destinataire final, ou `null` si le canal mail n'est pas exploitable. */
    email: string | null;
    sendAccount: { credentials: mailClient.MailCredentials; fromEmail: string } | null;
    webhook: string | null;
}

/** Un canal exploitable existe-t-il ? */
export function hasChannel(channels: Channels): boolean {
    return (channels.email !== null && channels.sendAccount !== null) || channels.webhook !== null;
}

/**
 * Les canaux d'un espace pour une feature donnée.
 *
 * Rien n'est deviné : sans réglage enregistré, aucun canal. C'est le défaut qui
 * compte — une feature qui se met à écrire à des gens sans qu'ils l'aient
 * demandé est précisément ce qu'on corrige.
 */
export async function resolveChannels(
    db: Database,
    cipher: Cipher,
    workspaceId: number,
    feature: NotificationFeature
): Promise<Channels> {
    const settings = await db.notificationSettings.get(workspaceId, feature);
    if (!settings) return { email: null, sendAccount: null, webhook: null };

    let email: string | null = null;
    let sendAccount: Channels['sendAccount'] = null;

    if (settings.email_enabled === 1 && settings.mail_account_id) {
        // Scopé à l'espace : aucune clé étrangère ne peut exprimer « ce compte
        // mail doit appartenir au même espace que ces réglages ». Un pointeur
        // devenu inter-espaces doit rendre « pas de canal », jamais ouvrir les
        // identifiants SMTP d'un compte étranger.
        const account = await db.mailAccounts.findById(settings.mail_account_id, workspaceId);
        // Seul un compte « open » peut envoyer sans session : un compte gardé
        // exige un déverrouillage que l'ordonnanceur de fond n'a jamais.
        if (account && account.enabled === 1 && account.security_tier === 'open') {
            const accountEmail = await cipher.tryDecrypt(account.email_address_enc);
            const custom = settings.email_enc ? await cipher.tryDecrypt(settings.email_enc) : null;
            email = custom || accountEmail;
            if (email && accountEmail) {
                try {
                    sendAccount = {
                        credentials: await decryptCredentials(cipher, account.credentials_enc),
                        fromEmail: accountEmail
                    };
                } catch {
                    // Identifiants illisibles : pas d'expéditeur, et surtout pas
                    // d'exception qui remonterait dans une boucle de fond.
                }
            }
        }
    }

    const webhook =
        settings.webhook_enabled === 1 && settings.webhook_enc ? await cipher.tryDecrypt(settings.webhook_enc) : null;

    return { email, sendAccount, webhook };
}

/**
 * Date et heure dans le corps d'une alerte, en français.
 *
 * Ici et non dans l'émetteur : les quatre features écrivent des corps de
 * message, et une alerte de base horodatée autrement qu'une alerte de
 * disponibilité donnerait l'impression de venir d'un autre produit. C'était déjà
 * le seul exemplaire, resté privé dans `UptimeMonitor` ; le rendre commun évite
 * simplement qu'un deuxième naisse.
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
     * Facultative, et c'est le point : une feature qui n'en fournit pas garde
     * exactement l'envoi d'avant. Elle n'est de toute façon employée que si le
     * webhook réglé est bien celui de Discord — voir {@link webhookBody}.
     */
    embeds?: Record<string, unknown>[];
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
 * La charge utile envoyée au webhook.
 *
 * Charge utile à trois têtes : `content` pour Discord, `text` pour Slack, les
 * champs structurés pour un point d'entrée maison. Aucun des trois ne gêne les
 * autres, ce qui évite de demander « quel service ? » à la configuration.
 *
 * **Sauf pour Discord dès qu'une feature fournit des embeds** : là, `content`
 * est retiré. Le garder ferait afficher deux fois la même alerte, le pavé de
 * texte au-dessus de sa propre mise en page — et l'embed ne serait plus une
 * amélioration, seulement une répétition. Le texte reste sur tous les autres
 * canaux, qui ne savent pas rendre un embed.
 *
 * Le reconnaissement passe par `isDiscordWebhook`, qui analyse l'URL au lieu
 * d'y chercher une sous-chaîne : un point d'entrée maison qui recevrait des
 * embeds à la place de son texte serait une régression silencieuse.
 *
 * Séparée pour être vérifiable : le choix se juge sur l'objet rendu, sans
 * réseau.
 */
export function webhookBody(url: string, alert: Alert): Record<string, unknown> {
    const text = alert.body.slice(0, WEBHOOK_TEXT_MAX);
    if (alert.embeds && alert.embeds.length > 0 && isDiscordWebhook(url)) {
        return { embeds: alert.embeds, ...alert.payload };
    }
    return { content: text, text, ...alert.payload };
}

/**
 * Livre une alerte sur tous les canaux configurés, et dit si **au moins un** l'a
 * acceptée.
 *
 * Chaque erreur est journalisée puis avalée, et les canaux sont indépendants :
 * un webhook en panne ne doit ni supprimer le mail, ni arrêter la boucle qui a
 * produit l'alerte.
 *
 * Le booléen n'est pas décoratif. Uptime marque son incident `notified` sur
 * cette réponse, et ne peut donc envoyer un « c'est revenu » que s'il a bien
 * envoyé le « c'est tombé » — sans quoi on recevrait un rétablissement sans
 * contexte. Un POST refusé n'est **pas** une livraison : le compter comme telle
 * était le bug que ce retour empêche. Les appelants qui n'en ont pas l'usage
 * l'ignorent simplement.
 */
export async function deliver(channels: Channels, alert: Alert, logger: Logger): Promise<boolean> {
    let delivered = false;

    if (channels.email && channels.sendAccount) {
        try {
            await mailClient.sendMail(channels.sendAccount.credentials, {
                from: channels.sendAccount.fromEmail,
                to: [{ name: null, address: channels.email }],
                subject: alert.subject,
                text: alert.body
            });
            delivered = true;
        } catch (e) {
            logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Alert mail failed');
        }
    }

    if (channels.webhook) {
        try {
            const response = await fetch(channels.webhook, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                signal: AbortSignal.timeout(10_000),
                body: JSON.stringify(webhookBody(channels.webhook, alert))
            });
            if (response.ok) delivered = true;
            else logger.warn({ reason: await webhookRejection(response) }, 'Alert webhook rejected');
        } catch (e) {
            logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Alert webhook failed');
        }
    }

    return delivered;
}

/**
 * Le squelette d'un `*.testNotification` : résout, refuse poliment s'il n'y a
 * rien à joindre, livre sinon.
 *
 * Les quatre commandes de test faisaient les mêmes six lignes. « Aucun canal
 * activé » y est une **réponse**, pas une exception : le dialogue affiche la
 * phrase telle quelle au lieu d'un « échec » qui laisserait croire à une panne
 * d'envoi.
 */
export async function sendTest(
    db: Database,
    cipher: Cipher,
    workspaceId: number,
    feature: NotificationFeature,
    alert: Alert,
    logger: Logger
): Promise<{ sent: boolean; error: string | null }> {
    const channels = await resolveChannels(db, cipher, workspaceId, feature);
    if (!hasChannel(channels)) {
        return { sent: false, error: 'Aucun canal activé (choisissez un compte mail « open » ou un webhook).' };
    }
    const sent = await deliver(channels, alert, logger);
    return {
        sent,
        error: sent ? null : 'Aucun canal n’a accepté l’envoi — vérifiez le compte expéditeur et l’URL du webhook.'
    };
}
