import type { NotificationFeature, NotificationSettings } from 'deveye-types';

import type { FeatureContext } from './_define';

/**
 * Lecture et écriture des canaux d'alerte, partagées par les features qui
 * notifient.
 *
 * Uptime et Sentinelle règlent exactement les mêmes champs — un compte
 * expéditeur, un destinataire, un webhook — et les recopier une fois par
 * émetteur aurait garanti la dérive : le jour où l'on ajoute un canal, une des
 * copies l'oublie. Ce qui les distingue tient dans un seul argument, `feature`,
 * qui désigne la ligne de `notification_settings` à lire.
 */

/**
 * Un compte mail est-il réellement capable d'envoyer sans intervention ?
 *
 * Trois conditions, et l'interface a besoin de la réponse pour dire « ce canal
 * ne partira pas » plutôt que d'afficher un réglage qui ment : le compte doit
 * exister **dans cet espace**, être actif, et appartenir au palier « open » —
 * un compte gardé exige un déverrouillage que l'ordonnanceur de fond n'a jamais.
 */
async function isMailAccountReady(ctx: FeatureContext, mailAccountId: number | null): Promise<boolean> {
    if (!mailAccountId) return false;
    const account = await ctx.db.mailAccounts.findById(mailAccountId, ctx.workspaceId);
    return !!account && account.enabled === 1 && account.security_tier === 'open';
}

/**
 * Les réglages d'une feature pour cet espace.
 *
 * Sans ligne enregistrée, **tout est éteint**. C'est le défaut qui compte : une
 * feature qui se mettrait à écrire à des gens sans qu'ils l'aient demandé est
 * exactement le travers que cette table sépare.
 */
export async function getNotificationSettings(
    ctx: FeatureContext,
    feature: NotificationFeature
): Promise<NotificationSettings> {
    const row = await ctx.db.notificationSettings.get(ctx.workspaceId, feature);
    const mailAccountId = row?.mail_account_id ?? null;
    return {
        emailEnabled: row?.email_enabled === 1,
        email: row?.email_enc ? await ctx.secure.open.tryDecrypt(row.email_enc) : null,
        mailAccountId,
        mailAccountReady: await isMailAccountReady(ctx, mailAccountId),
        webhookEnabled: row?.webhook_enabled === 1,
        webhookUrl: row?.webhook_enc ? await ctx.secure.open.tryDecrypt(row.webhook_enc) : null
    };
}

export interface NotificationSettingsInput {
    emailEnabled: boolean;
    /** Vide = l'adresse du compte expéditeur lui-même. */
    email: string;
    mailAccountId: number | null;
    webhookEnabled: boolean;
    webhookUrl: string;
}

/**
 * Écrit les réglages, chiffrés à l'étage **ouvert**.
 *
 * Ouvert et non gardé : ce sont les boucles de fond qui les relisent, sans
 * session ni mot de passe. Un secret rangé au palier gardé y serait illisible,
 * et l'alerte ne partirait jamais — en silence (voir `Docs/SECURITY_MODEL.md`).
 */
export async function setNotificationSettings(
    ctx: FeatureContext,
    feature: NotificationFeature,
    input: NotificationSettingsInput
): Promise<NotificationSettings> {
    const email = input.email.trim();
    const webhookUrl = input.webhookUrl.trim();
    await ctx.db.notificationSettings.set(ctx.workspaceId, feature, {
        emailEnabled: input.emailEnabled,
        emailEnc: email ? await ctx.secure.open.encrypt(email) : null,
        mailAccountId: input.mailAccountId,
        webhookEnabled: input.webhookEnabled,
        webhookEnc: webhookUrl ? await ctx.secure.open.encrypt(webhookUrl) : null
    });
    // Relu plutôt que reconstruit : `mailAccountReady` dépend de l'état du compte
    // et non de ce qu'on vient d'écrire, et le déduire ici le ferait mentir dès
    // qu'un compte est désactivé entre deux enregistrements.
    return getNotificationSettings(ctx, feature);
}
