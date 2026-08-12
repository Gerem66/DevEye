import type { Logger } from 'pino';
import type { NotificationFeature } from 'deveye-types';

import { decryptCredentials } from '@/features/mail/_shared';
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

/** Ce qu'une alerte porte, indépendamment du canal qui la transporte. */
export interface Alert {
    subject: string;
    body: string;
    /**
     * Champs structurés du webhook, en plus de `content`/`text`. Permet à un
     * point d'entrée maison de filtrer sans analyser du texte.
     */
    payload: Record<string, unknown>;
}

/**
 * Livre une alerte sur tous les canaux configurés.
 *
 * Chaque erreur est journalisée puis avalée, et les canaux sont indépendants :
 * un webhook en panne ne doit ni supprimer le mail, ni arrêter la boucle qui a
 * produit l'alerte.
 */
export async function deliver(channels: Channels, alert: Alert, logger: Logger): Promise<void> {
    if (channels.email && channels.sendAccount) {
        try {
            await mailClient.sendMail(channels.sendAccount.credentials, {
                from: channels.sendAccount.fromEmail,
                to: [{ name: null, address: channels.email }],
                subject: alert.subject,
                text: alert.body
            });
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
                // Charge utile à trois têtes : `content` pour Discord, `text`
                // pour Slack, les champs structurés pour un point d'entrée
                // maison. Aucun des trois ne gêne les autres, ce qui évite de
                // demander « quel service ? » à la configuration.
                body: JSON.stringify({
                    content: alert.body.slice(0, 1900),
                    text: alert.body.slice(0, 1900),
                    ...alert.payload
                })
            });
            if (!response.ok) {
                logger.warn({ status: response.status }, 'Alert webhook rejected');
            }
        } catch (e) {
            logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Alert webhook failed');
        }
    }
}
