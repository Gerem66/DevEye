import type { DeployTargetRow, DeployTargetWithUsageRow, DeploymentRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les cibles de déploiement de l'espace, et l'historique de ce qu'on y a poussé.
 *
 * **Portées par l'espace, jamais par un projet** (migration 080) : une pile
 * compose sert souvent deux projets, et un projet n'en garde qu'une liaison. Le
 * corollaire est que rien ici ne suit le `security_tier` d'un projet — tout est
 * à l'étage ouvert, et la garde atomique qu'exigeait l'ancienne écriture de
 * `updateDeployment` a disparu avec sa cause.
 */
export interface DeployRepo {
    // -- cibles -------------------------------------------------------------
    listTargets(workspaceId: number): Promise<DeployTargetWithUsageRow[]>;
    findTarget(id: number, workspaceId: number): Promise<DeployTargetRow | null>;
    findTargetWithUsage(id: number, workspaceId: number): Promise<DeployTargetWithUsageRow | null>;
    /** L'unicité d'une cible dans l'espace : même instance, même identifiant. */
    findTargetByExternal(
        workspaceId: number,
        credentialId: number,
        externalId: string
    ): Promise<DeployTargetRow | null>;
    countTargets(workspaceId: number): Promise<number>;
    createTarget(input: {
        workspaceId: number;
        credentialId: number;
        provider: string;
        kind: string;
        externalId: string;
        content: string;
    }): Promise<DeployTargetRow>;
    updateTarget(
        id: number,
        workspaceId: number,
        input: { credentialId: number | null; kind: string; externalId: string; content: string }
    ): Promise<DeployTargetRow | null>;
    deleteTarget(id: number, workspaceId: number): Promise<boolean>;
    /** Range les cibles : `ids` est la liste complète, rang = indice. */
    reorderTargets(workspaceId: number, ids: number[]): Promise<void>;

    // -- liaisons projet ----------------------------------------------------
    listLinkedTargetIds(projectId: number, workspaceId: number): Promise<number[]>;
    listLinkedProjectIds(targetId: number, workspaceId: number): Promise<number[]>;
    linkProject(projectId: number, workspaceId: number, targetId: number): Promise<void>;
    unlinkProject(projectId: number, workspaceId: number, targetId: number): Promise<boolean>;
    /** Retire toutes les liaisons d'un projet : sa conversion en confidentiel. */
    unlinkAllProjects(projectId: number, workspaceId: number): Promise<number>;

    // -- déploiements -------------------------------------------------------
    createDeployment(input: {
        targetId: number;
        workspaceId: number;
        externalId: string | null;
        triggeredByUserId: number;
        content: string;
    }): Promise<DeploymentRow>;
    updateDeployment(
        id: number,
        input: { externalId: string | null; status: string; finishedAt: number | null; content: string }
    ): Promise<void>;
    listDeployments(targetId: number, workspaceId: number, limit: number): Promise<DeploymentRow[]>;
    /**
     * Les déploiements encore en vol, toutes cibles confondues : c'est ce que
     * l'ordonnanceur doit aller réinterroger chez le fournisseur.
     */
    listInFlight(limit: number): Promise<DeploymentRow[]>;
}

/**
 * Ce qu'une liste montre sans ouvrir la fiche : l'adresse de l'instance, le
 * nombre de projets, et l'état du dernier déploiement.
 *
 * Par jointure et non par colonnes recopiées : un état dénormalisé se serait mis
 * à mentir dès le premier déploiement écrit par le service de fond, qui n'a
 * aucune raison de connaître la ligne de la cible.
 */
const TARGET_WITH_USAGE = `
    SELECT t.*, c.base_url,
           (SELECT COUNT(*) FROM project_deploy_links l WHERE l.target_id = t.id) AS project_count,
           d.status AS last_status,
           d.started_at AS last_deploy_at
      FROM deploy_targets t
      LEFT JOIN workspace_credentials c ON c.id = t.credential_id
      LEFT JOIN deployments d
             ON d.id = (SELECT id FROM deployments WHERE target_id = t.id ORDER BY started_at DESC, id DESC LIMIT 1)
`;

export function deployRepo(pool: Q): DeployRepo {
    return {
        async listTargets(workspaceId) {
            const r = await pool.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE} WHERE t.workspace_id = ? ORDER BY t.sort_order ASC, t.id ASC`,
                [workspaceId]
            );
            return r.rows;
        },
        async findTarget(id, workspaceId) {
            const r = await pool.query<DeployTargetRow>(
                'SELECT * FROM deploy_targets WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findTargetWithUsage(id, workspaceId) {
            const r = await pool.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE} WHERE t.id = ? AND t.workspace_id = ?`,
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findTargetByExternal(workspaceId, credentialId, externalId) {
            const r = await pool.query<DeployTargetRow>(
                'SELECT * FROM deploy_targets WHERE workspace_id = ? AND credential_id = ? AND external_id = ?',
                [workspaceId, credentialId, externalId]
            );
            return r.rows[0] ?? null;
        },
        async countTargets(workspaceId) {
            const r = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM deploy_targets WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(r.rows[0]?.n ?? 0);
        },
        async createTarget({ workspaceId, credentialId, provider, kind, externalId, content }) {
            // Une nouvelle cible atterrit à la fin de la liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur, un ajout ne le réarrange pas.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM deploy_targets WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await pool.query(
                `INSERT INTO deploy_targets
                     (workspace_id, credential_id, provider, target_kind, external_id, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, credentialId, provider, kind, externalId, Number(posRow.rows[0]?.next ?? 0), content]
            );
            const r = await pool.query<DeployTargetRow>('SELECT * FROM deploy_targets WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateTarget(id, workspaceId, { credentialId, kind, externalId, content }) {
            const res = await pool.query(
                `UPDATE deploy_targets SET credential_id = ?, target_kind = ?, external_id = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [credentialId, kind, externalId, content, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findTarget(id, workspaceId);
        },
        async deleteTarget(id, workspaceId) {
            // L'historique et les liaisons partent en CASCADE : ce sont des
            // dépendances de la cible, pas des faits qui lui survivent.
            const r = await pool.query('DELETE FROM deploy_targets WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async reorderTargets(workspaceId, ids) {
            for (const [index, id] of ids.entries()) {
                await pool.query('UPDATE deploy_targets SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    index,
                    id,
                    workspaceId
                ]);
            }
        },

        async listLinkedTargetIds(projectId, workspaceId) {
            // Trié comme la liste de la feature : les deux écrans montrent les
            // mêmes cibles, ils n'ont pas à les montrer dans deux ordres.
            const r = await pool.query<{ target_id: number }>(
                `SELECT l.target_id
                   FROM project_deploy_links l
                   JOIN deploy_targets t ON t.id = l.target_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY t.sort_order ASC, t.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.target_id));
        },
        async listLinkedProjectIds(targetId, workspaceId) {
            const r = await pool.query<{ project_id: number }>(
                'SELECT project_id FROM project_deploy_links WHERE target_id = ? AND workspace_id = ? ORDER BY project_id ASC',
                [targetId, workspaceId]
            );
            return r.rows.map((row) => Number(row.project_id));
        },
        async linkProject(projectId, workspaceId, targetId) {
            // La paire est la clé primaire : reposer la même liaison n'est pas
            // une erreur, c'est le même fait déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, targetId, workspaceId]
            );
        },
        async unlinkProject(projectId, workspaceId, targetId) {
            const r = await pool.query(
                'DELETE FROM project_deploy_links WHERE project_id = ? AND target_id = ? AND workspace_id = ?',
                [projectId, targetId, workspaceId]
            );
            return r.rowCount > 0;
        },
        async unlinkAllProjects(projectId, workspaceId) {
            const r = await pool.query('DELETE FROM project_deploy_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount;
        },

        async createDeployment({ targetId, workspaceId, externalId, triggeredByUserId, content }) {
            const res = await pool.query(
                `INSERT INTO deployments (target_id, workspace_id, external_id, status, triggered_by_user_id, content)
                 VALUES (?, ?, ?, 'queued', ?, ?)`,
                [targetId, workspaceId, externalId, triggeredByUserId, content]
            );
            const r = await pool.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateDeployment(id, { externalId, status, finishedAt, content }) {
            // Écriture simple : plus de garde atomique sur `security_tier`. Une
            // cible est d'espace, elle ne bascule jamais d'étage, donc la course
            // que cette garde protégeait n'existe plus (migration 080).
            await pool.query(
                'UPDATE deployments SET external_id = ?, status = ?, finished_at = ?, content = ? WHERE id = ?',
                [externalId, status, finishedAt, content, id]
            );
        },
        async listDeployments(targetId, workspaceId, limit) {
            const r = await pool.query<DeploymentRow>(
                `SELECT * FROM deployments WHERE target_id = ? AND workspace_id = ?
                 ORDER BY started_at DESC, id DESC LIMIT ?`,
                [targetId, workspaceId, limit]
            );
            return r.rows;
        },
        async listInFlight(limit) {
            const r = await pool.query<DeploymentRow>(
                `SELECT * FROM deployments WHERE status IN ('queued', 'running')
                 ORDER BY started_at ASC LIMIT ?`,
                [limit]
            );
            return r.rows;
        }
    };
}
