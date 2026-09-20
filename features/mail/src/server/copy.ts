import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { MailRepo } from './repo';

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
            drops: [
                'Ses dossiers et messages déjà relevés : la copie les relèvera de nouveau',
                // Un jeton OAuth est lié à l'application enregistrée par CE
                // serveur : ailleurs, le fournisseur peut le refuser.
                ...(rows[0]?.auth_method !== 'password'
                    ? ['Sa connexion par le fournisseur, à refaire si la copie part vers un autre serveur']
                    : [])
            ]
        };
    },
    async admit({ repo, quota }) {
        await quota.assert('accounts', async (owned) => (await repo.accounts.countInWorkspaces(owned)) + 1);
    }
};
