import { databaseGetSettings, databaseSetSettings, databaseTestNotification } from 'deveye-types';

import { formatMoment, sendTest } from '@/Services/notifications';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { getNotificationSettings, setNotificationSettings } from '../_notifications';
import { READ, WRITE } from './_shared';

/**
 * Où partent les alertes de base.
 *
 * **Ses propres canaux**, depuis la migration 085. `DatabaseMonitor` appelait
 * `UptimeMonitor.resolveChannels` : un seuil SQL franchi arrivait donc sur le
 * salon désigné pour la disponibilité. C'était assumé et documenté — « mêmes
 * destinataires, une seule configuration à tenir à jour » — mais c'est mot pour
 * mot le raisonnement que Sentinelle avait suivi avant la 075, avec le même
 * effet : on ne pouvait ni éteindre les alertes de base sans éteindre Uptime,
 * ni les router ailleurs, et rien à l'écran ne disait où elles partaient.
 *
 * La reprise a été faite **à l'identique** par la migration : la ligne `uptime`
 * a été recopiée dans `database`, donc personne n'a perdu au redémarrage une
 * alerte qu'il recevait la veille. Les deux jeux divergent ensuite librement.
 *
 * Ce qui déclenche une alerte n'est pas ici : c'est le relevé périodique
 * (`Services/DatabaseMonitor.ts`), qui notifie **aux transitions**, dans les
 * deux sens, et seulement sur une base dont la surveillance est active.
 */

export const databaseGetSettingsFeature: FeatureDefinition<
    typeof databaseGetSettings.command,
    typeof databaseGetSettings.input,
    typeof databaseGetSettings.output
> = defineFeature({
    ...databaseGetSettings,
    access: READ,
    handler: async (ctx) => ({ settings: await getNotificationSettings(ctx, 'database') })
});

export const databaseSetSettingsFeature: FeatureDefinition<
    typeof databaseSetSettings.command,
    typeof databaseSetSettings.input,
    typeof databaseSetSettings.output
> = defineFeature({
    ...databaseSetSettings,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Même garde que les trois autres émetteurs : un compte « guarded »
        // exige un déverrouillage que le relevé périodique n'a jamais, et
        // l'accepter ici produirait un canal qui ne part jamais, en silence.
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
        const settings = await setNotificationSettings(ctx, 'database', input);
        ctx.audit({
            action: 'database.setSettings',
            description: 'Notifications de base de données modifiées',
            metadata: { email: input.emailEnabled, webhook: input.webhookEnabled }
        });
        return { settings };
    }
});

export const databaseTestNotificationFeature: FeatureDefinition<
    typeof databaseTestNotification.command,
    typeof databaseTestNotification.input,
    typeof databaseTestNotification.output
> = defineFeature({
    ...databaseTestNotification,
    access: WRITE,
    handler: async (ctx) => {
        const at = Math.floor(Date.now() / 1000);
        return sendTest(
            ctx.db,
            ctx.secure.open,
            ctx.workspaceId,
            'database',
            {
                subject: '[DevEye] Test de notification — Bases de données',
                body: [
                    'Ceci est un test des notifications de Bases de données.',
                    '',
                    `Envoyé le : ${formatMoment(at)}`,
                    'Si vous lisez ce message, les alertes de seuil vous parviendront bien.',
                    'Elles ne partent que sur une base dont la surveillance est active :',
                    'une alerte posée sur une base au repos n’est évaluée par personne.'
                ].join('\n'),
                payload: { event: 'database_test', at }
            },
            ctx.logger
        );
    }
});

export const databaseNotificationFeatures = [
    databaseGetSettingsFeature,
    databaseSetSettingsFeature,
    databaseTestNotificationFeature
];
