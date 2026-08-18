import { deployGetSettings, deploySetSettings, deployTestNotification } from 'deveye-types';

import { formatMoment, sendTest } from '@/Services/notifications';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { getNotificationSettings, setNotificationSettings } from '../_notifications';
import { READ, WRITE } from './_shared';

/**
 * Où partent les avis de déploiement.
 *
 * **Ses propres canaux**, dès le premier jour. Les trois émetteurs qui
 * existaient avant ont chacun connu le même détour — Sentinelle empruntait ceux
 * d'Uptime jusqu'à la migration 075, Bases de données jusqu'à la 085 — avec le
 * même effet : une alerte arrivait sur un salon désigné pour autre chose, sans
 * moyen de l'éteindre sans éteindre l'autre feature. Ce module n'a pas eu à
 * refaire l'erreur pour la corriger.
 *
 * Le comportement vit dans `_notifications.ts` et `Services/notifications.ts` :
 * seul le nom de la ligne de `notification_settings` change d'un émetteur à
 * l'autre. C'est ce qui rend ces trois commandes aussi courtes — et ce qui
 * garantit qu'un canal ajouté demain arrivera dans les quatre features à la fois.
 *
 * Ce qui déclenche un avis n'est pas ici : c'est le rapprochement de fond
 * (`IntegrationSyncService.syncDeployTargets`) qui prévient à l'atterrissage
 * d'un déploiement, échec comme succès. Un déploiement est un fait ponctuel, pas
 * un état continu : contrairement à Uptime, il n'y a pas de « retour à la
 * normale » à annoncer — la mise en production suivante le dira.
 */

export const deployGetSettingsFeature: FeatureDefinition<
    typeof deployGetSettings.command,
    typeof deployGetSettings.input,
    typeof deployGetSettings.output
> = defineFeature({
    ...deployGetSettings,
    access: READ,
    handler: async (ctx) => ({ settings: await getNotificationSettings(ctx, 'deploy') })
});

export const deploySetSettingsFeature: FeatureDefinition<
    typeof deploySetSettings.command,
    typeof deploySetSettings.input,
    typeof deploySetSettings.output
> = defineFeature({
    ...deploySetSettings,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Même garde qu'Uptime et Sentinelle : un compte « guarded » exige un
        // déverrouillage que la boucle de fond n'a jamais, et l'accepter ici
        // produirait un canal qui ne part jamais, en silence.
        if (input.emailEnabled && input.mailAccountId !== null) {
            const account = await ctx.db.mailAccounts.findById(input.mailAccountId, ctx.workspaceId);
            if (!account) throw new FeatureError('not_found', 'Compte mail introuvable');
            if (account.security_tier !== 'open') {
                throw new FeatureError(
                    'validation',
                    'Un compte « guarded » ne peut pas envoyer d’alertes automatiques : choisissez un compte « open »'
                );
            }
        }
        const settings = await setNotificationSettings(ctx, 'deploy', input);
        ctx.audit({
            action: 'deploy.setSettings',
            description: 'Notifications de déploiement modifiées',
            metadata: { email: input.emailEnabled, webhook: input.webhookEnabled }
        });
        return { settings };
    }
});

export const deployTestNotificationFeature: FeatureDefinition<
    typeof deployTestNotification.command,
    typeof deployTestNotification.input,
    typeof deployTestNotification.output
> = defineFeature({
    ...deployTestNotification,
    access: WRITE,
    handler: async (ctx) => {
        const at = Math.floor(Date.now() / 1000);
        return sendTest(
            ctx.db,
            ctx.secure.open,
            ctx.workspaceId,
            'deploy',
            {
                subject: '[DevEye] Test de notification — Déploiement',
                body: [
                    'Ceci est un test des notifications de Déploiement.',
                    '',
                    `Envoyé le : ${formatMoment(at)}`,
                    'Si vous lisez ce message, les avis de mise en production vous parviendront bien.',
                    'Ils sont distincts des alertes de disponibilité (Uptime), de sécurité (Sentinelle)',
                    'et de base de données, qui ont chacune leurs propres canaux.'
                ].join('\n'),
                payload: { event: 'deploy_test', at }
            },
            ctx.logger
        );
    }
});

export const deployNotificationFeatures = [
    deployGetSettingsFeature,
    deploySetSettingsFeature,
    deployTestNotificationFeature
];
