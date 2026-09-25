import type { DeployCredentialRow, DeploymentRow, DeployTargetRow, DeployTargetSyncRow } from '../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

/**
 * Une cible augmentée de ce qu'une liste montre sans ouvrir la fiche : l'adresse
 * de l'instance et l'état du dernier déploiement, par jointure. Le nombre de
 * projets vient du contrat de Projets, `toTarget` le reçoit en paramètre.
 */
export interface DeployTargetWithUsageRow extends DeployTargetRow {
    base_url: string | null;
    last_status: string | null;
    last_deploy_at: number | null;
}

/**
 * Les cibles de déploiement de l'espace et l'historique de ce qu'on y a poussé,
 * portées par l'espace, jamais par un projet ; tout est à l'étage ouvert.
 * L'historique n'est pas seulement ce que DevEye a déclenché : le rapprochement
 * de fond (`listTargetsDue`, `createRemoteDeployment`) recopie ce que le
 * fournisseur connaît, d'où une liste juste même sans réseau vers Dokploy.
 * `project_deploy_links` est une table de Projets : le module ne la lit pas.
 */
export interface DeployRepo {
    listTargets(workspaceId: number): Promise<DeployTargetWithUsageRow[]>;
    /** Comme `listTargets`, plus les cibles projetées vers cet espace. */
    listVisibleTargets(workspaceId: number): Promise<DeployTargetWithUsageRow[]>;
    findTarget(id: number, workspaceId: number): Promise<DeployTargetRow | null>;
    /** Comme `findTarget`, mais accepte aussi une cible projetée vers cet espace. */
    findVisibleTarget(id: number, workspaceId: number): Promise<DeployTargetRow | null>;
    findTargetWithUsage(id: number, workspaceId: number): Promise<DeployTargetWithUsageRow | null>;
    findVisibleTargetWithUsage(id: number, workspaceId: number): Promise<DeployTargetWithUsageRow | null>;
    /** L'unicité d'une cible dans l'espace : même instance, même identifiant. */
    findTargetByExternal(
        workspaceId: number,
        credentialId: number,
        externalId: string
    ): Promise<DeployTargetRow | null>;
    /** L'unicité d'une cible portée par une machine : même appareil, même service. */
    findTargetByDevice(workspaceId: number, deviceId: string, externalId: string): Promise<DeployTargetRow | null>;
    countTargets(workspaceId: number): Promise<number>;
    /**
     * Les cibles sondées de tous ces espaces : ce que l'offre de leur
     * propriétaire borne. Une cible portée par une machine ne coûte rien au
     * repos, et les machines ont leur propre limite.
     */
    countTargetsInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Ce que compte `countTargetsInWorkspaces`, du plus ancien au plus récent : le stock du quota `targets`. */
    listStockTargets(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    createTarget(input: {
        workspaceId: number;
        credentialId: number | null;
        deviceId: string | null;
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

    /**
     * Les accès Dokploy de l'espace, clé chiffrée à l'étage ouvert (le suivi de
     * fond tourne sans session). Le secret n'est rendu qu'à travers la ligne
     * brute ; le DTO n'en porte qu'un booléen.
     */
    listCredentials(workspaceId: number): Promise<DeployCredentialRow[]>;
    findCredential(id: number, workspaceId: number): Promise<DeployCredentialRow | null>;
    createCredential(input: {
        workspaceId: number;
        provider: string;
        label: string;
        baseUrl: string | null;
        secretEnc: string;
    }): Promise<DeployCredentialRow>;
    updateCredential(
        id: number,
        workspaceId: number,
        /** `secretEnc` absent = on garde le secret en place. */
        input: { label: string; baseUrl: string | null; secretEnc?: string }
    ): Promise<DeployCredentialRow | null>;
    /** Retire une clé. Les cibles qui s'en servaient restent, sans clé : indéployables, et le disent. */
    removeCredential(id: number, workspaceId: number): Promise<boolean>;
    /** Combien de cibles s'appuient sur chaque clé : ce qu'une suppression va couper, avant de cliquer. */
    countCredentialUses(workspaceId: number): Promise<Map<number, number>>;

    /**
     * Les cibles à réinterroger, la plus urgente d'abord, les espaces servis à
     * tour de rôle : la première de chaque espace passe avant la deuxième de
     * quiconque. Une cible qui a un déploiement en vol passe à chaque tour, les
     * autres attendent `staleBefore` ; `limit` plafonne la rafale sortante. Les
     * cibles sans jeton, ou dont l'instance Dokploy n'a pas d'adresse, sont
     * écartées ici, comme celles des accès de `skipCredentialIds` (occupés ou en
     * recul) et les `pausedIds` que l'offre tient en pause : filtrées après le
     * `LIMIT`, ces dernières occuperaient la fenêtre sans jamais avancer.
     */
    listTargetsDue(
        limit: number,
        staleBefore: number,
        skipCredentialIds: readonly number[],
        pausedIds: readonly number[]
    ): Promise<DeployTargetSyncRow[]>;
    /** Horodate un rapprochement réussi ; c'est lui qui sort du premier import. */
    markTargetSynced(id: number, at: number): Promise<void>;

    createDeployment(input: {
        targetId: number;
        workspaceId: number;
        externalId: string | null;
        triggeredByUserId: number;
        content: string;
    }): Promise<DeploymentRow>;
    /**
     * Enregistre un déploiement découvert chez le fournisseur, sans auteur, avec
     * son état et sa date. `notified` explicite : le premier import d'une cible
     * entre en base déjà notifié, sans quoi il enverrait un avis par ligne.
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
    /**
     * Réécrit le seul blob, sans toucher à l'état : retient l'identifiant du
     * message de suivi sans risquer d'écraser statut et date de fin.
     */
    setDeploymentContent(id: number, content: string): Promise<void>;
    listDeployments(targetId: number, workspaceId: number, limit: number): Promise<DeploymentRow[]>;
    findDeployment(id: number): Promise<DeploymentRow | null>;
    /**
     * Les déploiements par une machine restés en vol : leur attente vivait dans
     * le processus, un redémarrage les laisse sans verdict.
     */
    listInFlightAgentDeployments(): Promise<DeploymentRow[]>;
}

/**
 * Ce qu'une liste montre sans ouvrir la fiche, par jointure et non par colonnes
 * recopiées : un état dénormalisé mentirait dès le premier déploiement écrit
 * par le service de fond.
 */
const TARGET_WITH_USAGE = `
    SELECT t.*, c.base_url,
           d.status AS last_status,
           d.started_at AS last_deploy_at
      FROM deploy_targets t
      LEFT JOIN ft_deploy_credentials c ON c.id = t.credential_id
      LEFT JOIN deployments d
             ON d.id = (SELECT id FROM deployments WHERE target_id = t.id ORDER BY started_at DESC, id DESC LIMIT 1)
`;

export function createRepo(q: SdkQueryable): DeployRepo {
    async function findTarget(id: number, workspaceId: number): Promise<DeployTargetRow | null> {
        const rows = await q.query<DeployTargetRow>('SELECT * FROM deploy_targets WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    async function findCredential(id: number, workspaceId: number): Promise<DeployCredentialRow | null> {
        const rows = await q.query<DeployCredentialRow>(
            'SELECT * FROM ft_deploy_credentials WHERE id = ? AND workspace_id = ?',
            [id, workspaceId]
        );
        return rows[0] ?? null;
    }

    return {
        async listTargets(workspaceId) {
            return q.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE} WHERE t.workspace_id = ? ORDER BY t.sort_order ASC, t.id ASC`,
                [workspaceId]
            );
        },
        async listVisibleTargets(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : une cible projetée
            // se range après les locales, par identifiant.
            return q.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE} WHERE t.workspace_id = ?
                 UNION
                 ${TARGET_WITH_USAGE}
                  JOIN item_shares sh
                    ON sh.feature = 'deploy' AND sh.item_id = t.id AND sh.home_workspace_id = t.workspace_id
                 WHERE sh.workspace_id = ?
                 ORDER BY sort_order ASC, id ASC`,
                [workspaceId, workspaceId]
            );
        },
        findTarget,
        async findVisibleTarget(id, workspaceId) {
            const rows = await q.query<DeployTargetRow>(
                `SELECT t.* FROM deploy_targets t
                  WHERE t.id = ?
                    AND (t.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'deploy' AND sh.item_id = t.id
                                       AND sh.home_workspace_id = t.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findVisibleTargetWithUsage(id, workspaceId) {
            const rows = await q.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE}
                  WHERE t.id = ?
                    AND (t.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'deploy' AND sh.item_id = t.id
                                       AND sh.home_workspace_id = t.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findTargetWithUsage(id, workspaceId) {
            const rows = await q.query<DeployTargetWithUsageRow>(
                `${TARGET_WITH_USAGE} WHERE t.id = ? AND t.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findTargetByExternal(workspaceId, credentialId, externalId) {
            const rows = await q.query<DeployTargetRow>(
                'SELECT * FROM deploy_targets WHERE workspace_id = ? AND credential_id = ? AND external_id = ?',
                [workspaceId, credentialId, externalId]
            );
            return rows[0] ?? null;
        },
        async countTargets(workspaceId) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM deploy_targets WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async findTargetByDevice(workspaceId, deviceId, externalId) {
            const rows = await q.query<DeployTargetRow>(
                'SELECT * FROM deploy_targets WHERE workspace_id = ? AND device_id = ? AND external_id = ?',
                [workspaceId, deviceId, externalId]
            );
            return rows[0] ?? null;
        },
        async countTargetsInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ n: number }>(
                "SELECT COUNT(*) AS n FROM deploy_targets WHERE workspace_id IN (?) AND provider <> 'agent'",
                [workspaceIds]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async listStockTargets(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ id: number; workspace_id: number }>(
                `SELECT id, workspace_id FROM deploy_targets WHERE workspace_id IN (?) AND provider <> 'agent'
                  ORDER BY created ASC, id ASC`,
                [workspaceIds]
            );
            return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
        },
        async createTarget({ workspaceId, credentialId, deviceId, provider, kind, externalId, content }) {
            // Une nouvelle cible atterrit à la fin de la liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur, un ajout ne le réarrange pas.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM deploy_targets WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO deploy_targets
                     (workspace_id, credential_id, device_id, provider, target_kind, external_id, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    credentialId,
                    deviceId,
                    provider,
                    kind,
                    externalId,
                    Number(posRows[0]?.next ?? 0),
                    content
                ]
            );
            const rows = await q.query<DeployTargetRow>('SELECT * FROM deploy_targets WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateTarget(id, workspaceId, { credentialId, kind, externalId, content }) {
            const res = await q.execute(
                `UPDATE deploy_targets SET credential_id = ?, target_kind = ?, external_id = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [credentialId, kind, externalId, content, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return findTarget(id, workspaceId);
        },
        async deleteTarget(id, workspaceId) {
            // L'historique et les liaisons partent en CASCADE : ce sont des
            // dépendances de la cible, pas des faits qui lui survivent.
            const res = await q.execute('DELETE FROM deploy_targets WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorderTargets(workspaceId, ids) {
            for (const [index, id] of ids.entries()) {
                await q.execute('UPDATE deploy_targets SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    index,
                    id,
                    workspaceId
                ]);
            }
        },

        async listCredentials(workspaceId) {
            return q.query<DeployCredentialRow>(
                'SELECT * FROM ft_deploy_credentials WHERE workspace_id = ? ORDER BY label ASC',
                [workspaceId]
            );
        },
        findCredential,
        async createCredential({ workspaceId, provider, label, baseUrl, secretEnc }) {
            const res = await q.execute(
                'INSERT INTO ft_deploy_credentials (workspace_id, provider, label, base_url, secret_enc) VALUES (?, ?, ?, ?, ?)',
                [workspaceId, provider, label, baseUrl, secretEnc]
            );
            const rows = await q.query<DeployCredentialRow>('SELECT * FROM ft_deploy_credentials WHERE id = ?', [
                res.insertId
            ]);
            return rows[0];
        },
        async updateCredential(id, workspaceId, { label, baseUrl, secretEnc }) {
            // Secret absent = on garde celui en place : le client ne le reçoit
            // jamais, il ne peut donc pas le renvoyer inchangé.
            const res = secretEnc
                ? await q.execute(
                      `UPDATE ft_deploy_credentials SET label = ?, base_url = ?, secret_enc = ?
                        WHERE id = ? AND workspace_id = ?`,
                      [label, baseUrl, secretEnc, id, workspaceId]
                  )
                : await q.execute(
                      'UPDATE ft_deploy_credentials SET label = ?, base_url = ? WHERE id = ? AND workspace_id = ?',
                      [label, baseUrl, id, workspaceId]
                  );
            if (res.affectedRows === 0) return null;
            return findCredential(id, workspaceId);
        },
        async removeCredential(id, workspaceId) {
            // Pas de clé étrangère `ON DELETE SET NULL` vers cette table : InnoDB
            // revalidait la ligne mise à NULL contre un parent que la même
            // cascade supprimait, et la suppression d'un espace échouait dessus.
            // Les cibles de la clé passent donc à NULL ici, avant que la ligne
            // ne parte.
            await q.execute(
                'UPDATE deploy_targets SET credential_id = NULL WHERE credential_id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            const res = await q.execute('DELETE FROM ft_deploy_credentials WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async countCredentialUses(workspaceId) {
            const rows = await q.query<{ credential_id: number; uses: number }>(
                `SELECT credential_id, COUNT(*) AS uses FROM deploy_targets
                  WHERE workspace_id = ? AND credential_id IS NOT NULL
                  GROUP BY credential_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.credential_id), Number(row.uses)]));
        },

        async listTargetsDue(limit, staleBefore, skipCredentialIds, pausedIds) {
            // `NOT IN ()` n'est pas du SQL : chaque clause n'existe que non vide.
            const skip = skipCredentialIds.length > 0 ? 'AND c.id NOT IN (?)' : '';
            const paused = pausedIds.length > 0 ? 'AND t.id NOT IN (?)' : '';
            // Sous-requête plutôt que HAVING : le compte des déploiements en vol
            // est un scalaire corrélé, pas une agrégation du groupe, et le
            // filtrer demande donc de le matérialiser d'abord. `turn` numérote
            // les cibles dues de chaque espace : trié en premier, il sert les
            // espaces à tour de rôle.
            return q.query<DeployTargetSyncRow>(
                `SELECT * FROM (
                     SELECT x.*,
                            ROW_NUMBER() OVER (
                                PARTITION BY x.workspace_id
                                ORDER BY x.in_flight DESC, x.synced_at IS NULL DESC, x.synced_at ASC, x.id ASC
                            ) AS turn
                       FROM (
                            SELECT t.*, c.base_url,
                                   (SELECT COUNT(*) FROM deployments d
                                     WHERE d.target_id = t.id AND d.status IN ('queued', 'running')) AS in_flight
                              FROM deploy_targets t
                              JOIN ft_deploy_credentials c ON c.id = t.credential_id
                             WHERE (c.provider <> 'dokploy' OR (c.base_url IS NOT NULL AND c.base_url <> ''))
                                   ${skip} ${paused}
                       ) AS x
                      WHERE x.in_flight > 0 OR x.synced_at IS NULL OR x.synced_at < ?
                 ) AS y
                  ORDER BY y.turn ASC, y.in_flight DESC, y.synced_at IS NULL DESC, y.synced_at ASC, y.id ASC
                  LIMIT ?`,
                [
                    ...(skipCredentialIds.length > 0 ? [skipCredentialIds] : []),
                    ...(pausedIds.length > 0 ? [[...pausedIds]] : []),
                    staleBefore,
                    limit
                ]
            );
        },
        async markTargetSynced(id, at) {
            await q.execute('UPDATE deploy_targets SET synced_at = ? WHERE id = ?', [at, id]);
        },

        async createDeployment({ targetId, workspaceId, externalId, triggeredByUserId, content }) {
            const res = await q.execute(
                `INSERT INTO deployments (target_id, workspace_id, external_id, status, triggered_by_user_id, content)
                 VALUES (?, ?, ?, 'queued', ?, ?)`,
                [targetId, workspaceId, externalId, triggeredByUserId, content]
            );
            const rows = await q.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', [res.insertId]);
            return rows[0];
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
            const res = await q.execute(
                `INSERT INTO deployments
                     (target_id, workspace_id, external_id, status, triggered_by_user_id,
                      started_at, finished_at, notified, content)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                [targetId, workspaceId, externalId, status, startedAt, finishedAt, notified ? 1 : 0, content]
            );
            const rows = await q.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async markDeploymentNotified(id) {
            await q.execute('UPDATE deployments SET notified = 1 WHERE id = ?', [id]);
        },
        async setDeploymentContent(id, content) {
            await q.execute('UPDATE deployments SET content = ? WHERE id = ?', [content, id]);
        },
        async updateDeployment(id, { externalId, status, finishedAt, content }) {
            await q.execute(
                'UPDATE deployments SET external_id = ?, status = ?, finished_at = ?, content = ? WHERE id = ?',
                [externalId, status, finishedAt, content, id]
            );
        },
        async listDeployments(targetId, workspaceId, limit) {
            return q.query<DeploymentRow>(
                `SELECT * FROM deployments WHERE target_id = ? AND workspace_id = ?
                 ORDER BY started_at DESC, id DESC LIMIT ?`,
                [targetId, workspaceId, limit]
            );
        },
        async findDeployment(id) {
            const rows = await q.query<DeploymentRow>('SELECT * FROM deployments WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async listInFlightAgentDeployments() {
            return q.query<DeploymentRow>(
                `SELECT d.* FROM deployments d
                   JOIN deploy_targets t ON t.id = d.target_id
                  WHERE t.provider = 'agent' AND d.status IN ('queued', 'running')`
            );
        }
    };
}
