import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell
} from '@deveye/types/sdk/server';

import type { MailRepo } from './repo';

/**
 * Le changement d'espace d'un compte : ses identifiants, ses dossiers et les
 * enveloppes déjà relevées. Un compte au palier gardé est refusé en amont par
 * `shareable`, son contenu étant chiffré par le mot de passe de son
 * propriétaire ; seul un compte ouvert voyage, et tout son arbre suit l'étage
 * ouvert de son nouvel espace.
 *
 * Ce qui ne suit pas : un canal d'alerte de l'espace quitté qui expédiait par ce
 * compte. Il désigne un compte devenu étranger, et le serveur le refuse à
 * chaque résolution plutôt que d'envoyer de travers ; il faut lui rendre un
 * expéditeur d'ici. Le module ne peut pas l'annoncer, la table des canaux ne lui
 * appartenant pas.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à un
 * compte doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'mail_accounts', idColumn: 'id', ownerColumn: 'id', column: 'display_name_enc' },
    { table: 'mail_accounts', idColumn: 'id', ownerColumn: 'id', column: 'email_address_enc' },
    { table: 'mail_accounts', idColumn: 'id', ownerColumn: 'id', column: 'last_sync_error_enc' },
    { table: 'mail_accounts', idColumn: 'id', ownerColumn: 'id', column: 'credentials_enc' },
    { table: 'mail_folders', idColumn: 'id', ownerColumn: 'account_id', column: 'name_enc' },
    // Les messages pendent au compte par leur dossier : d'où le sous-parcours,
    // qui garde la conversion d'un seul tenant plutôt qu'un dossier à la fois.
    {
        table: 'mail_messages',
        idColumn: 'id',
        ownerColumn: 'folder_id',
        ownerScope: 'SELECT id FROM mail_folders WHERE account_id = ?',
        column: 'envelope_enc'
    }
];

export const mailMove: FeatureItemsMove<MailRepo> = {
    async plan({ q, itemId }) {
        // Aucun nom unique par espace à heurter : deux espaces peuvent relever
        // la même boîte.
        return { blockers: [], drops: [], rows: await countMovableCells(q, CELLS, Number(itemId)) };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const accountId = Number(itemId);
        await resealCells(q, CELLS, accountId, ciphers);
        // Dossiers et messages ne portent pas d'espace : ils suivent leur compte
        // sans une écriture de plus.
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM mail_accounts WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE mail_accounts SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), accountId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce compte n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
