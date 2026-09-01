import { FeatureError, type FeatureItemsMove, type SdkCipher, type SdkQueryable } from '@deveye/types/sdk/server';

import { MOVE_CELLS, type UptimeEncryptedCell, type UptimeRepo } from './repo';

/**
 * Le changement d'espace d'un service : sa ligne change de domicile, et tout ce
 * qui pend à lui (`MOVE_CELLS`) est relu sous la clé de l'espace quitté puis
 * rescellé sous celle du nouveau.
 */
interface StoredCell {
    cell: UptimeEncryptedCell;
    id: number;
    value: string;
}

/**
 * Les valeurs à convertir. Une cellule vide n'a rien à faire ici : un service
 * qui n'a jamais échoué n'a aucun message d'erreur, et c'est le cas courant.
 */
async function readCells(q: SdkQueryable, serviceId: number): Promise<StoredCell[]> {
    const out: StoredCell[] = [];
    for (const cell of MOVE_CELLS) {
        const rows = await q.query<{ row_id: number; value: string }>(
            `SELECT ${cell.idColumn} AS row_id, ${cell.column} AS value FROM ${cell.table}
              WHERE ${cell.ownerColumn} = ? AND ${cell.column} IS NOT NULL AND ${cell.column} <> ''`,
            [serviceId]
        );
        for (const row of rows) out.push({ cell, id: Number(row.row_id), value: String(row.value) });
    }
    return out;
}

export const uptimeMove: FeatureItemsMove<UptimeRepo> = {
    async plan(repo, itemId, fromWorkspaceId) {
        const serviceId = Number(itemId);
        // Aucun refus à déclarer : un service est autonome. Ni source d'espace
        // (il porte son URL), ni nom unique par espace, ni palier gardé.
        return {
            blockers: [],
            drops: [],
            rows: await repo.services.countEncryptedCells(serviceId, fromWorkspaceId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const serviceId = Number(itemId);
        // Tout lu et converti avant la moindre écriture : si une ligne résiste,
        // on abandonne sans rien avoir touché plutôt que de laisser un service à
        // moitié converti, dont la seconde moitié serait définitivement illisible.
        const cells = await readCells(q, serviceId);
        const converted = await Promise.all(
            cells.map(async (stored) => ({ ...stored, value: await reseal(stored, ciphers) }))
        );

        for (const { cell, id, value } of converted) {
            await q.execute(
                `UPDATE ${cell.table} SET ${cell.column} = ? WHERE ${cell.idColumn} = ? AND ${cell.ownerColumn} = ?`,
                [value, id, serviceId]
            );
        }

        const res = await q.execute('UPDATE uptime_services SET workspace_id = ? WHERE id = ? AND workspace_id = ?', [
            toWorkspaceId,
            serviceId,
            fromWorkspaceId
        ]);
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce service n’est plus dans cet espace : déplacement annulé.');
        }
    }
};

async function reseal(stored: StoredCell, ciphers: { from: SdkCipher; to: SdkCipher }): Promise<string> {
    const plain = await ciphers.from.tryDecrypt(stored.value);
    if (plain === null) {
        throw new FeatureError(
            'internal',
            `Une ligne de ${stored.cell.table} est illisible : déplacement annulé, rien n’a été modifié.`
        );
    }
    return ciphers.to.encrypt(plain);
}
