import type { NotificationFeature, NotificationSettingsRow } from 'deveye-types';

import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les canaux d'alerte d'un espace, **par feature**.
 *
 * Une table indexée sur `(espace, feature)` plutôt qu'une table par émetteur :
 * le mécanisme est commun, la configuration ne l'est pas. Uptime prévient qu'un
 * service est tombé, Sentinelle qu'une machine est suspecte — ce ne sont ni les
 * mêmes destinataires ni la même urgence, et un émetteur de plus ne doit pas
 * coûter une migration.
 */
export interface NotificationSettingsRepo {
    get(workspaceId: number, feature: NotificationFeature): Promise<NotificationSettingsRow | null>;
    set(
        workspaceId: number,
        feature: NotificationFeature,
        input: {
            emailEnabled: boolean;
            /** Destinataire chiffré, ou `null` pour l'adresse du compte expéditeur. */
            emailEnc: string | null;
            /** Renvoie à `mail_accounts.id` ; le palier « open » est vérifié par le handler. */
            mailAccountId: number | null;
            webhookEnabled: boolean;
            /** URL de webhook chiffrée, ou `null`. */
            webhookEnc: string | null;
        }
    ): Promise<NotificationSettingsRow>;
}

export function notificationSettingsRepo(pool: Q): NotificationSettingsRepo {
    return {
        async get(workspaceId, feature) {
            const r = await pool.query<NotificationSettingsRow>(
                'SELECT * FROM notification_settings WHERE workspace_id = ? AND feature = ?',
                [workspaceId, feature]
            );
            return r.rows[0] ?? null;
        },
        async set(workspaceId, feature, { emailEnabled, emailEnc, mailAccountId, webhookEnabled, webhookEnc }) {
            await pool.query(
                `INSERT INTO notification_settings
                     (workspace_id, feature, email_enabled, email_enc, mail_account_id, webhook_enabled, webhook_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     email_enabled   = VALUES(email_enabled),
                     email_enc       = VALUES(email_enc),
                     mail_account_id = VALUES(mail_account_id),
                     webhook_enabled = VALUES(webhook_enabled),
                     webhook_enc     = VALUES(webhook_enc)`,
                [
                    workspaceId,
                    feature,
                    emailEnabled ? 1 : 0,
                    emailEnc,
                    mailAccountId,
                    webhookEnabled ? 1 : 0,
                    webhookEnc
                ]
            );
            const row = await this.get(workspaceId, feature);
            if (!row) throw new Error('Réglages de notification écrits mais introuvables');
            return row;
        }
    };
}
