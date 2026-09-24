import {
    countMovableCells,
    FeatureError,
    movableCellsOf,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import type { UptimeRepo } from './repo';
import { uptimeTree } from './copy';

/**
 * Le changement d'espace d'un service : sa ligne change de domicile, et tout ce
 * qui pend à lui est relu sous la clé de l'espace quitté puis rescellé sous
 * celle du nouveau.
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(uptimeTree);

export const uptimeMove: FeatureItemsMove<UptimeRepo> = {
    async plan({ q, itemId }) {
        // Aucun refus à déclarer : un service est autonome. Ni source d'espace
        // (il porte son URL), ni nom unique par espace, ni palier gardé.
        const pages = await q.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM ft_uptime_page_services WHERE service_id = ?',
            [Number(itemId)]
        );
        const drops =
            Number(pages[0]?.n ?? 0) > 0
                ? ['Sa place sur les pages de statut de cet espace : il en est retiré, elles restent ici']
                : [];
        return { blockers: [], drops, rows: await countMovableCells(q, CELLS, Number(itemId)) };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const serviceId = Number(itemId);
        await resealCells(q, CELLS, serviceId, ciphers);
        // Le domicile en dernier : un échec de conversion laisse le service
        // entier dans son espace, sous sa clé.
        const res = await q.execute('UPDATE uptime_services SET workspace_id = ? WHERE id = ? AND workspace_id = ?', [
            toWorkspaceId,
            serviceId,
            fromWorkspaceId
        ]);
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce service n’est plus dans cet espace : déplacement annulé.');
        }
        // Une page ne montre que les services de son espace : celui qui part
        // quitte les pages de l'espace qu'il quitte.
        await q.execute('DELETE FROM ft_uptime_page_services WHERE service_id = ?', [serviceId]);
    }
};
