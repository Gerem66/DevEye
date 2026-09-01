import { FeatureError, type FeatureItemsMove, type SdkQueryable } from '@deveye/types/sdk/server';

import type { DevicesRepo } from './repo';

/**
 * Le changement d'espace d'un appareil. Rien à resceller : un appareil ne
 * chiffre aucune de ses colonnes, son relevé compris, parce que le moteur de
 * sécurité doit le lire sans session. Sa ligne change de domicile ; relevés,
 * présence et constats la suivent, ne pendant qu'à son identifiant.
 *
 * L'agent n'a rien à réappairer : il s'authentifie par sa clé, et l'espace ne
 * se lit qu'au moment d'afficher.
 *
 * Ne suivent pas, et le module n'a pas à le dire : les exemptions Sentinelle,
 * réglées par espace dans une table qui ne lui appartient pas. Les constats
 * qu'elles taisaient ici reparaîtront là-bas, jusqu'à ce qu'on les y taise.
 */

/**
 * Deux appareils de même empreinte dans un espace, c'est le même appareil vu
 * deux fois (`uniq_workspace_fingerprint`) : la collision se décide avant
 * d'écrire, plutôt qu'en erreur SQL au milieu du geste.
 */
async function fingerprintTaken(q: SdkQueryable, deviceId: string, toWorkspaceId: number): Promise<boolean> {
    const rows = await q.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM devices
          WHERE workspace_id = ? AND fingerprint = (SELECT fingerprint FROM devices WHERE id = ?)`,
        [toWorkspaceId, deviceId]
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

export const devicesMove: FeatureItemsMove<DevicesRepo> = {
    async plan({ q, itemId, toWorkspaceId }) {
        return {
            blockers: (await fingerprintTaken(q, itemId, toWorkspaceId))
                ? ['Cet appareil est déjà appairé dans cet espace.']
                : [],
            drops: [],
            // Aucune colonne chiffrée : le déplacement est une seule écriture.
            rows: 0
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId }) {
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM devices WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE devices SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), itemId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Cet appareil n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
