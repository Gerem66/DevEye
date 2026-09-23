import {
    countMovableCells,
    FeatureError,
    movableCellsOf,
    resealCells,
    type FeatureItemsMove,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { AudienceRepo } from './repo';
import { audienceTree } from './copy';
import { ingestOf } from './_shared';

/**
 * Le changement d'espace d'un site : sa fiche, ses entonnoirs, ses libellés et
 * tout ce que ses formulaires ont reçu. L'audience elle-même (événements,
 * sessions, agrégats quotidiens) suit sans rien à resceller, aucune de ses
 * colonnes n'étant chiffrée, et sans changement d'espace, ces tables ne pendant
 * qu'au site.
 *
 * La clé publique du site ne bouge pas : elle est unique pour tout DevEye, donc
 * les balises déjà posées sur les pages continuent d'écrire au bon endroit.
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(audienceTree);

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

        // Le cache de l'ingestion retient l'espace d'un site sans expiration : sans
        // cette purge, les visites suivantes resteraient chiffrées sous la clé de
        // l'espace quitté, donc illisibles depuis le nouveau, et définitivement.
        ingestOf()?.invalidate();
    }
};
