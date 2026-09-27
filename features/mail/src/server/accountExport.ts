import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { MailRepo } from './repo';

export const mailAccountExport: FeatureAccountExport<MailRepo> = {
    tables: {
        mail_accounts: {
            file: 'comptes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['display_name_enc', 'email_address_enc', 'last_sync_error_enc'],
            dates: { last_sync_at: 's', last_error_at: 's', created: 's' },
            omit: ['credentials_enc']
        },
        mail_settings: {
            file: 'reglages.json',
            where: 'workspace_id = ?',
            key: ['workspace_id'],
            json: ['trusted_image_domains']
        },
        mail_folders: {
            skip: 'Les dossiers des boîtes restent sur leur serveur de messagerie, d’où la relève les relit.'
        },
        mail_messages: {
            skip: 'Les messages restent sur le serveur de messagerie de chaque boîte : DevEye n’en garde qu’un aperçu, que la relève reconstruit.'
        }
    }
};
