import type { DeployCredentialRow, DeploymentRow, DeployTargetRow, DeployTargetSyncRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * La même, augmentée de ce qu'une liste montre sans ouvrir la fiche : l'adresse
 * de l'instance et l'état du dernier déploiement. Calculé par jointure plutôt
 * que recopié dans des colonnes, qui dériveraient.
 *
 * Le nombre de projets qui s'en servent n'en fait plus partie : la table de
 * liaison (`project_deploy_links`) appartient à Projets, et le module ne lit
 * aucune table de Projets. Le compte vient de son contrat
 * (`PROJECTS_USAGE_PROVIDER`), et `toTarget` le reçoit en paramètre.
 */
export interface DeployTargetWithUsageRow extends DeployTargetRow {
    base_url: string | null;
    last_status: string | null;
    last_deploy_at: number | null;
}

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
 *
 * Depuis le rapatriement en module, deux choses ont changé de dépôt. Les
 * liaisons vers les projets (`project_deploy_links`) ont rejoint
 * `db/repos/projectLinks.ts` : c'est une table de Projets, que le module ne lit
 * pas. Les clés Dokploy sont entrées ici à la place (`ft_deploy_credentials`,
 * migration 099 du socle) : un module possède ses accès, et une clé qui
 * déploie n'a jamais eu de raison de partager la table d'un jeton qui lit des
 * dépôts.
 */
export interface DeployRepo {
    // -- cibles -------------------------------------------------------------
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

    // -- clés Dokploy -------------------------------------------------------
    /**
     * Les accès Dokploy de l'espace : l'adresse d'une instance et sa clé d'API,
     * chiffrée à l'étage ouvert (le suivi de fond tourne sans session). Le
     * secret n'est rendu qu'à travers la ligne brute, que seule la couche
     * feature manipule ; le DTO n'en porte qu'un booléen.
     */
    listCredentials(workspaceId: number): Promise<DeployCredentialRow[]>;
    findCredential(id: number, workspaceId: number): Promise<DeployCredentialRow | null>;
    createCredential(input: {
        workspaceId: number;
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
    /**
     * Retire une clé. Les cibles qui s'en servaient **restent**, sans clé :
     * elles cessent d'être déployables et le disent, plutôt que de disparaître
     * avec leur accès.
     */
    removeCredential(id: number, workspaceId: number): Promise<boolean>;
    /**
     * Combien de cibles s'appuient sur chaque clé de l'espace : c'est ce
     * chiffre qui dit à l'écran ce qu'une suppression va couper, **avant** de
     * cliquer.
     */
    countCredentialUses(workspaceId: number): Promise<Map<number, number>>;

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
    /**
     * Réécrit le seul blob, sans toucher à l'état.
     *
     * Sert à retenir l'identifiant du message de suivi dès qu'il est ouvert.
     * Distincte de `updateDeployment` exprès : celle-ci réécrit aussi le statut
     * et la date de fin, et s'en servir ici obligerait à les repasser — donc à
     * risquer de les écraser avec ce qu'on croyait savoir.
     */
    setDeploymentContent(id: number, content: string): Promise<void>;
    listDeployments(targetId: number, workspaceId: number, limit: number): Promise<DeploymentRow[]>;
}

/**
 * Ce qu'une liste montre sans ouvrir la fiche : l'adresse de l'instance et
 * l'état du dernier déploiement.
 *
 * Par jointure et non par colonnes recopiées : un état dénormalisé se serait mis
 * à mentir dès le premier déploiement écrit par le service de fond, qui n'a
 * aucune raison de connaître la ligne de la cible. L'adresse vient de la table
 * des clés du module (`ft_deploy_credentials`) ; le nombre de projets, qui
 * était la troisième colonne, vient désormais du contrat de Projets.
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
            // se range après les locales, par identifiant — même arbitrage que
            // les services Uptime.
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
        async createTarget({ workspaceId, credentialId, provider, kind, externalId, content }) {
            // Une nouvelle cible atterrit à la fin de la liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur, un ajout ne le réarrange pas.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM deploy_targets WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO deploy_targets
                     (workspace_id, credential_id, provider, target_kind, external_id, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, credentialId, provider, kind, externalId, Number(posRows[0]?.next ?? 0), content]
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
        async createCredential({ workspaceId, label, baseUrl, secretEnc }) {
            const res = await q.execute(
                'INSERT INTO ft_deploy_credentials (workspace_id, label, base_url, secret_enc) VALUES (?, ?, ?, ?)',
                [workspaceId, label, baseUrl, secretEnc]
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
            // Le ménage explicite qui remplace la clé étrangère
            // `fk_deploy_target_credential` (080, `ON DELETE SET NULL`), retirée
            // par la 099 et non recréée vers la table du module : InnoDB
            // revalidait la ligne mise à NULL contre un parent que la même
            // cascade supprimait, et la suppression d'un espace échouait
            // dessus. Les cibles de la clé passent donc à NULL ICI, dans
            // l'espace de la clé, avant que la ligne ne parte : ce que la
            // contrainte faisait sans le dire.
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

        async listTargetsDue(limit, staleBefore) {
            // Sous-requête plutôt que HAVING : le compte des déploiements en vol
            // est un scalaire corrélé, pas une agrégation du groupe, et le
            // filtrer demande donc de le matérialiser d'abord.
            return q.query<DeployTargetSyncRow>(
                `SELECT * FROM (
                     SELECT t.*, c.base_url,
                            (SELECT COUNT(*) FROM deployments d
                              WHERE d.target_id = t.id AND d.status IN ('queued', 'running')) AS in_flight
                       FROM deploy_targets t
                       JOIN ft_deploy_credentials c ON c.id = t.credential_id
                      WHERE c.base_url IS NOT NULL AND c.base_url <> ''
                 ) AS x
                  WHERE x.in_flight > 0 OR x.synced_at IS NULL OR x.synced_at < ?
                  ORDER BY x.in_flight DESC, x.synced_at IS NULL DESC, x.synced_at ASC, x.id ASC
                  LIMIT ?`,
                [staleBefore, limit]
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
            // Écriture simple : plus de garde atomique sur `security_tier`. Une
            // cible est d'espace, elle ne bascule jamais d'étage, donc la course
            // que cette garde protégeait n'existe plus (migration 080).
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
        }
    };
}
