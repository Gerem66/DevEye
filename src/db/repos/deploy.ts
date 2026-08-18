import type { DeployTargetRow, DeployTargetSyncRow, DeployTargetWithUsageRow, DeploymentRow } from 'deveye-types';
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
 *
 * L'historique n'est plus seulement **ce que DevEye a déclenché** (migration
 * 085). `listTargetsDue` et `createRemoteDeployment` servent le rapprochement de
 * fond, qui recopie en base ce que le fournisseur connaît — y compris les
 * déploiements partis de son interface, d'une CI ou d'un push git. C'est ce qui
 * fait qu'une liste ouverte sans réseau vers Dokploy dit malgré tout la vérité
 * du dernier état connu.
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

    // -- rapprochement de fond ----------------------------------------------
    /**
     * Les cibles qu'il est temps de réinterroger, la plus urgente d'abord.
     *
     * Deux régimes dans une seule requête : une cible qui a un déploiement en
     * vol passe **à chaque tour**, les autres attendent `staleBefore`. C'est ce
     * qui permet de suivre un déploiement à la minute sans sonder toute la liste
     * aussi souvent — et de rester borné : `limit` plafonne la rafale sortante,
     * quel que soit le nombre de cibles déclarées.
     *
     * Les cibles sans jeton ou sans adresse d'instance sont écartées ici plutôt
     * que dans l'appelant : il n'y a rien à leur demander, et les faire remonter
     * ne servirait qu'à consommer le budget d'un tour.
     */
    listTargetsDue(limit: number, staleBefore: number): Promise<DeployTargetSyncRow[]>;
    /** Horodate un rapprochement réussi ; c'est lui qui sort du premier import. */
    markTargetSynced(id: number, at: number): Promise<void>;

    // -- déploiements -------------------------------------------------------
    createDeployment(input: {
        targetId: number;
        workspaceId: number;
        externalId: string | null;
        triggeredByUserId: number;
        content: string;
    }): Promise<DeploymentRow>;
    /**
     * Enregistre un déploiement **découvert chez le fournisseur**, avec son état
     * et sa date à lui.
     *
     * Distincte de `createDeployment`, qui écrit un déclenchement parti d'ici :
     * celle-ci n'a pas d'auteur (`triggered_by_user_id` reste NULL — l'ordre
     * vient de l'interface de Dokploy, d'une CI ou d'un push), commence rarement
     * à `queued`, et porte `notified` explicitement : le premier import d'une
     * cible entre en base **déjà notifié**, sans quoi il enverrait un avis par
     * ligne d'historique.
     */
    createRemoteDeployment(input: {
        targetId: number;
        workspaceId: number;
        externalId: string | null;
        status: string;
        startedAt: number;
        finishedAt: number | null;
        notified: boolean;
        content: string;
    }): Promise<DeploymentRow>;
    updateDeployment(
        id: number,
        input: { externalId: string | null; status: string; finishedAt: number | null; content: string }
    ): Promise<void>;
    /** Marque l'avis parti. Séparé de l'écriture d'état : on notifie **après**
     *  avoir enregistré, pour qu'un envoi qui échoue ne se répète pas en boucle
     *  mais qu'un état perdu ne fasse pas non plus disparaître le déploiement. */
    markDeploymentNotified(id: number): Promise<void>;
    listDeployments(targetId: number, workspaceId: number, limit: number): Promise<DeploymentRow[]>;
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

        async listTargetsDue(limit, staleBefore) {
            // Sous-requête plutôt que HAVING : le compte des déploiements en vol
            // est un scalaire corrélé, pas une agrégation du groupe, et le
            // filtrer demande donc de le matérialiser d'abord.
            const r = await pool.query<DeployTargetSyncRow>(
                `SELECT * FROM (
                     SELECT t.*, c.base_url,
                            (SELECT COUNT(*) FROM deployments d
                              WHERE d.target_id = t.id AND d.status IN ('queued', 'running')) AS in_flight
                       FROM deploy_targets t
                       JOIN workspace_credentials c ON c.id = t.credential_id
                      WHERE c.provider = 'dokploy' AND c.base_url IS NOT NULL AND c.base_url <> ''
                 ) AS x
                  WHERE x.in_flight > 0 OR x.synced_at IS NULL OR x.synced_at < ?
                  ORDER BY x.in_flight DESC, x.synced_at IS NULL DESC, x.synced_at ASC, x.id ASC
                  LIMIT ?`,
                [staleBefore, limit]
            );
            return r.rows;
        },
        async markTargetSynced(id, at) {
            await pool.query('UPDATE deploy_targets SET synced_at = ? WHERE id = ?', [at, id]);
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
        async createRemoteDeployment({
            targetId,
            workspaceId,
            externalId,
            status,
            startedAt,
            finishedAt,
            notified,
            content
        }) {
            const res = await pool.query(
                `INSERT INTO deployments
                     (target_id, workspace_id, external_id, status, triggered_by_user_id,
                      started_at, finished_at, notified, content)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                [targetId, workspaceId, externalId, status, startedAt, finishedAt, notified ? 1 : 0, content]
            );
            const r = await pool.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async markDeploymentNotified(id) {
            await pool.query('UPDATE deployments SET notified = 1 WHERE id = ?', [id]);
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
        }
    };
}
