import type { DashboardTileRow } from '../../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * L'agencement de la vue d'ensemble d'un projet, et ses indicateurs sur mesure.
 * Rien n'est semé à la création d'un projet : le catalogue des tuiles
 * automatiques est du code client, et la table ne porte que ce qui a été
 * arrangé. Une tuile automatique jamais touchée n'a donc pas de ligne.
 */
export interface ProjectDashboardRepo {
    list(projectId: number, workspaceId: number): Promise<DashboardTileRow[]>;
    /**
     * L'ordre complet, en une passe. Les tuiles automatiques absentes de la
     * liste partent ; celles qui portent un indicateur restent, leur requête ne
     * s'efface pas par un geste d'ordre.
     */
    arrange(projectId: number, workspaceId: number, tiles: readonly { key: string; hidden: boolean }[]): Promise<void>;
    upsertKpi(input: {
        projectId: number;
        workspaceId: number;
        tileKey: string;
        databaseId: number;
        content: string;
    }): Promise<DashboardTileRow | null>;
    removeKpi(projectId: number, workspaceId: number, tileKey: string): Promise<boolean>;
    recordMeasure(
        projectId: number,
        tileKey: string,
        outcome: { value: number | null; error: string | null; at: number }
    ): Promise<void>;
}

export function projectDashboardRepo(q: SdkQueryable): ProjectDashboardRepo {
    return {
        async list(projectId, workspaceId) {
            return q.query<DashboardTileRow>(
                `SELECT * FROM ft_projects_dashboard_tiles
                  WHERE project_id = ? AND workspace_id = ?
                  ORDER BY sort_order ASC, id ASC`,
                [projectId, workspaceId]
            );
        },
        async arrange(projectId, workspaceId, tiles) {
            for (const [index, tile] of tiles.entries()) {
                await q.execute(
                    `INSERT INTO ft_projects_dashboard_tiles (project_id, workspace_id, tile_key, sort_order, hidden, content)
                     VALUES (?, ?, ?, ?, ?, '')
                     ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), hidden = VALUES(hidden)`,
                    [projectId, workspaceId, tile.key, index, tile.hidden ? 1 : 0]
                );
            }
            const kept = tiles.map((t) => t.key);
            // Une tuile automatique qui n'est plus au catalogue ne laisse rien
            // derrière ; un indicateur garde sa ligne, elle porte sa requête.
            const placeholders = kept.length === 0 ? null : kept.map(() => '?').join(', ');
            await q.execute(
                `DELETE FROM ft_projects_dashboard_tiles
                  WHERE project_id = ? AND workspace_id = ? AND content = ''
                    ${placeholders === null ? '' : `AND tile_key NOT IN (${placeholders})`}`,
                [projectId, workspaceId, ...kept]
            );
        },
        async upsertKpi({ projectId, workspaceId, tileKey, databaseId, content }) {
            await q.execute(
                `INSERT INTO ft_projects_dashboard_tiles (project_id, workspace_id, tile_key, sort_order, hidden, database_id, content)
                 VALUES (?, ?, ?, 0, 0, ?, ?)
                 ON DUPLICATE KEY UPDATE database_id = VALUES(database_id), content = VALUES(content)`,
                [projectId, workspaceId, tileKey, databaseId, content]
            );
            const rows = await q.query<DashboardTileRow>(
                'SELECT * FROM ft_projects_dashboard_tiles WHERE project_id = ? AND tile_key = ?',
                [projectId, tileKey]
            );
            return rows[0] ?? null;
        },
        async removeKpi(projectId, workspaceId, tileKey) {
            const res = await q.execute(
                `DELETE FROM ft_projects_dashboard_tiles
                  WHERE project_id = ? AND workspace_id = ? AND tile_key = ? AND content <> ''`,
                [projectId, workspaceId, tileKey]
            );
            return res.affectedRows > 0;
        },
        async recordMeasure(projectId, tileKey, outcome) {
            // La valeur survit à un échec : la tuile montre le dernier nombre
            // connu, grisé, sous le message qui dit pourquoi il ne bouge plus.
            await q.execute(
                `UPDATE ft_projects_dashboard_tiles
                    SET last_number = COALESCE(?, last_number), last_error = ?, last_check_at = ?
                  WHERE project_id = ? AND tile_key = ?`,
                [outcome.value, outcome.error, outcome.at, projectId, tileKey]
            );
        }
    };
}
