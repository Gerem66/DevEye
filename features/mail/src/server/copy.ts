import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { MailCredentials } from './client';
import type { MailRepo } from './repo';

/**
 * Les serveurs de la boîte, sans aucun mot de passe ni jeton : une copie passe
 * par le navigateur de qui la fait, qui peut n'avoir que la lecture sur la
 * boîte. Elle arrive à reconnecter.
 */
function withoutSecrets(plain: string): string {
    const credentials = JSON.parse(plain) as MailCredentials;
    const proxy = credentials.proxy && { ...credentials.proxy, password: null };
    return JSON.stringify(
        credentials.kind === 'password'
            ? {
                  ...credentials,
                  imap: { ...credentials.imap, password: '' },
                  smtp: { ...credentials.smtp, password: '' },
                  proxy
              }
            : { ...credentials, accessToken: '', refreshToken: null, expiresAt: 0, proxy }
    );
}

/**
 * Ce dont une boîte est faite : son compte, et ce que la relève en a rapatrié.
 * C'est la liste que le déplacement rescelle et que la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à un compte doit
 * y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible, et une copie l'emporte sous une clé que la destination
 * n'a pas. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
export const mailTree: ItemTree = [
    {
        table: 'mail_accounts',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        userColumn: 'user_id',
        orderColumn: 'sort_order',
        sealed: ['display_name_enc', 'email_address_enc', 'last_sync_error_enc', 'credentials_enc'],
        redact: { credentials_enc: withoutSecrets },
        omit: ['last_sync_at', 'last_sync_status', 'last_error_at', 'last_sync_error_enc', 'created'],
        tier: { column: 'security_tier', open: 'open', private: 'guarded' }
    },
    { table: 'mail_folders', idColumn: 'id', ownerColumn: 'account_id', sealed: ['name_enc'], cache: true },
    // Les messages pendent au compte par leur dossier : d'où le sous-parcours,
    // qui garde la conversion d'un seul tenant plutôt qu'un dossier à la fois.
    {
        table: 'mail_messages',
        idColumn: 'id',
        ownerColumn: 'folder_id',
        ownerScope: 'SELECT id FROM mail_folders WHERE account_id = ?',
        sealed: ['envelope_enc'],
        cache: true
    }
];

export const mailCopy: FeatureItemsCopy<MailRepo> = {
    tree: mailTree,
    async plan({ q, itemId }) {
        const rows = await q.query<{ auth_method: string }>('SELECT auth_method FROM mail_accounts WHERE id = ?', [
            Number(itemId)
        ]);
        return {
            blockers: [],
            carries: [],
            drops: [
                rows[0]?.auth_method === 'password'
                    ? 'Son mot de passe : la copie arrive à reconnecter, en le saisissant de nouveau'
                    : 'Sa connexion par le fournisseur : la copie arrive à reconnecter',
                'Ses dossiers et messages déjà relevés : la copie les relèvera de nouveau'
            ]
        };
    },
    async admit({ repo, quota }) {
        await quota.assert('accounts', async (owned) => (await repo.accounts.countInWorkspaces(owned)) + 1);
    }
};
