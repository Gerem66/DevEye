import type { ProjectEventRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface ProjectHistoryRepo {
    /**
     * Une page de la frise, **du plus récent au plus ancien** — c'est l'ordre où
     * l'on pagine et celui où l'on lit une histoire de projet. `before` exclu ;
     * `limit + 1` lignes sont lues pour savoir s'il en reste.
     */
    listByProject(
        projectId: number,
        workspaceId: number,
        before: number | null,
        limit: number
    ): Promise<ProjectEventRow[]>;
    record(input: {
        projectId: number;
        workspaceId: number;
        actorUserId: number | null;
        kind: string;
        refType: string | null;
        refId: number | null;
        content: string;
    }): Promise<void>;
}

export function projectHistoryRepo(pool: Q): ProjectHistoryRepo {
    return {
        async listByProject(projectId, workspaceId, before, limit) {
            const r = await pool.query<ProjectEventRow>(
                `SELECT * FROM project_events
                 WHERE project_id = ? AND workspace_id = ?${before === null ? '' : ' AND id < ?'}
                 ORDER BY id DESC
                 LIMIT ?`,
                before === null ? [projectId, workspaceId, limit] : [projectId, workspaceId, before, limit]
            );
            return r.rows;
        },
        async record({ projectId, workspaceId, actorUserId, kind, refType, refId, content }) {
            await pool.query(
                `INSERT INTO project_events (project_id, workspace_id, actor_user_id, kind, ref_type, ref_id, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [projectId, workspaceId, actorUserId, kind, refType, refId, content]
            );
        }
    };
}
