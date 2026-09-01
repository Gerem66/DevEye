import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { AudienceRepo } from './repo';

/**
 * Le changement d'espace d'un site : sa fiche, ses entonnoirs et ses libellés.
 * L'audience elle-même (événements, sessions, agrégats quotidiens) suit sans
 * rien à resceller, aucune de ses colonnes n'étant chiffrée, et sans changement
 * d'espace, ces tables ne pendant qu'au site.
 *
 * La clé publique du site ne bouge pas : elle est unique pour tout DevEye, donc
 * les balises déjà posées sur les pages continuent d'écrire au bon endroit.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à un site
 * doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'audience_sites', idColumn: 'id', ownerColumn: 'id', column: 'content' },
    { table: 'audience_funnels', idColumn: 'id', ownerColumn: 'site_id', column: 'content' },
    { table: 'audience_funnel_steps', idColumn: 'id', ownerColumn: 'site_id', column: 'content' },
    { table: 'audience_labels', idColumn: 'id', ownerColumn: 'site_id', column: 'content' }
];

/** Le nom est unique par espace (`uniq_audience_site_name`), par condensé. */
async function nameTaken(q: SdkQueryable, siteId: number, toWorkspaceId: number): Promise<boolean> {
    const rows = await q.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audience_sites
          WHERE workspace_id = ? AND name_ref = (SELECT name_ref FROM audience_sites WHERE id = ?)`,
        [toWorkspaceId, siteId]
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

export const audienceMove: FeatureItemsMove<AudienceRepo> = {
    async plan({ q, itemId, toWorkspaceId }) {
        const siteId = Number(itemId);
        const blockers = (await nameTaken(q, siteId, toWorkspaceId))
            ? ['Un site du même nom existe déjà dans cet espace.']
            : [];
        return { blockers, drops: [], rows: await countMovableCells(q, CELLS, siteId) };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const siteId = Number(itemId);
        await resealCells(q, CELLS, siteId, ciphers);
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM audience_sites WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE audience_sites SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), siteId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce site n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
