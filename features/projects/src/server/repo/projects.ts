import type { ProjectRow, ProjectSecurityTier, ProjectVersionSource } from '../../contracts/domain';
import type { ProjectStatus } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Compteurs d'un projet, calculés uniquement sur les colonnes en clair : le
 * portefeuille affiche avancement, retards et non-lus sans déchiffrer une ligne, et
 * reste donc juste quand un projet gardé est verrouillé.
 */
export interface ProjectStats {
    project_id: number;
    card_total: number;
    card_done: number;
    card_overdue: number;
    next_due_date: number | null;
    unread: number;
}

/**
 * La table `projects` : le portefeuille de l'espace, et ce qu'un autre espace y
 * projette. Toute écriture prend le `workspaceId` de la ligne visée, son domicile,
 * qui n'est pas l'espace actif quand le projet est projeté ; c'est le handler qui le
 * résout, le dépôt ne fait que refuser une écriture adressée au mauvais espace.
 */
export interface ProjectRepo {
    /**
     * Les projets visibles depuis cet espace : les siens, plus ceux qu'un autre
     * espace y projette. Actifs ou archivés, deux ensembles disjoints : les vivants
     * dans l'ordre choisi, locaux d'abord ; les archivés du plus récemment archivé au
     * plus ancien, d'où qu'ils viennent. La branche projetée ne retient que les
     * projets ouverts, en garde de cohérence : un projet gardé est chiffré par le mot
     * de passe de son auteur, illisible dans tout autre espace.
     */
    listVisible(workspaceId: number, archived: boolean): Promise<ProjectRow[]>;
    /** Un projet de cet espace : son domicile, jamais une fenêtre. */
    findById(id: number, workspaceId: number): Promise<ProjectRow | null>;
    /** Comme `findById`, mais accepte aussi un projet ouvert projeté vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<ProjectRow | null>;
    create(input: {
        userId: number;
        workspaceId: number;
        status: ProjectStatus;
        showOverview: boolean;
        securityTier: ProjectSecurityTier;
        startDate: number | null;
        dueDate: number | null;
        content: string;
    }): Promise<ProjectRow>;
    update(
        id: number,
        workspaceId: number,
        input: {
            status: ProjectStatus;
            showOverview: boolean;
            startDate: number | null;
            dueDate: number | null;
            content: string;
        }
    ): Promise<ProjectRow | null>;
    setStatus(id: number, workspaceId: number, status: ProjectStatus): Promise<ProjectRow | null>;
    /** Pose la source de version ; le numéro lui-même vit dans `content`. */
    setVersionSource(id: number, workspaceId: number, source: ProjectVersionSource): Promise<ProjectRow | null>;
    /** Bascule le palier après que l'arbre a été re-chiffré par l'appelant. */
    setSecurityTier(
        id: number,
        workspaceId: number,
        tier: ProjectSecurityTier,
        content: string
    ): Promise<ProjectRow | null>;
    archive(id: number, workspaceId: number, at: number): Promise<boolean>;
    restore(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, projectIds: number[]): Promise<void>;
    /**
     * Les compteurs des projets donnés, pour l'appelant donné : les non-lus sont les
     * siens. Les archivés n'en ont pas, un projet rangé n'a plus d'avancement.
     */
    statsFor(projectIds: number[], userId: number, now: number): Promise<ProjectStats[]>;
}

/** Prochain rang libre à la fin du portefeuille (0 s'il est vide). */
async function nextSortOrder(q: SdkQueryable, workspaceId: number): Promise<number> {
    const rows = await q.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM projects
         WHERE workspace_id = ? AND archived_at IS NULL`,
        [workspaceId]
    );
    return Number(rows[0]?.next ?? 0);
}

export function projectRepo(q: SdkQueryable): ProjectRepo {
    return {
        async listVisible(workspaceId, archived) {
            // `sort_order` appartient à l'espace d'origine : un projet projeté se
            // range après les locaux, dans l'ordre de chez lui. Un rang par espace
            // demanderait une colonne par projection.
            return q.query<ProjectRow>(
                `SELECT v.* FROM (
                     SELECT p.* FROM projects p WHERE p.workspace_id = ?
                     UNION
                     SELECT p.* FROM projects p
                       JOIN item_shares sh
                         ON sh.feature = 'projects' AND sh.item_id = p.id AND sh.home_workspace_id = p.workspace_id
                      WHERE sh.workspace_id = ? AND p.security_tier = 'open'
                 ) v
                 WHERE v.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
                 ORDER BY ${archived ? 'v.archived_at DESC' : 'v.workspace_id <> ?, v.sort_order ASC'}, v.id ASC`,
                archived ? [workspaceId, workspaceId] : [workspaceId, workspaceId, workspaceId]
            );
        },
        async findById(id, workspaceId) {
            const rows = await q.query<ProjectRow>('SELECT * FROM projects WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async findVisible(id, workspaceId) {
            const rows = await q.query<ProjectRow>(
                `SELECT p.* FROM projects p
                  WHERE p.id = ?
                    AND (p.workspace_id = ?
                         OR (p.security_tier = 'open'
                             AND EXISTS (SELECT 1 FROM item_shares sh
                                          WHERE sh.feature = 'projects' AND sh.item_id = p.id
                                            AND sh.home_workspace_id = p.workspace_id
                                            AND sh.workspace_id = ?)))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async create({ userId, workspaceId, status, showOverview, securityTier, startDate, dueDate, content }) {
            const sortOrder = await nextSortOrder(q, workspaceId);
            const res = await q.execute(
                `INSERT INTO projects
                     (workspace_id, user_id, status, show_overview, security_tier, sort_order, start_date, due_date,
                      content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    userId,
                    status,
                    showOverview ? 1 : 0,
                    securityTier,
                    sortOrder,
                    startDate,
                    dueDate,
                    content
                ]
            );
            const rows = await q.query<ProjectRow>('SELECT * FROM projects WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, { status, showOverview, startDate, dueDate, content }) {
            const res = await q.execute(
                `UPDATE projects SET status = ?, show_overview = ?, start_date = ?, due_date = ?, content = ?,
                        updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [status, showOverview ? 1 : 0, startDate, dueDate, content, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setStatus(id, workspaceId, status) {
            const res = await q.execute(
                'UPDATE projects SET status = ?, updated = UNIX_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
                [status, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setVersionSource(id, workspaceId, source) {
            const res = await q.execute(
                'UPDATE projects SET version_source = ?, updated = UNIX_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
                [source, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setSecurityTier(id, workspaceId, tier, content) {
            const res = await q.execute(
                `UPDATE projects SET security_tier = ?, content = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [tier, content, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findById(id, workspaceId);
        },
        async archive(id, workspaceId, at) {
            const res = await q.execute('UPDATE projects SET archived_at = ? WHERE id = ? AND workspace_id = ?', [
                at,
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async restore(id, workspaceId) {
            // Son ancien rang appartenait à une liste qui a bougé : il repart de la
            // fin.
            const sortOrder = await nextSortOrder(q, workspaceId);
            const res = await q.execute(
                'UPDATE projects SET archived_at = NULL, sort_order = ? WHERE id = ? AND workspace_id = ?',
                [sortOrder, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async reorder(workspaceId, projectIds) {
            // Chaque id prend le rang de son indice, et seules les lignes de cet
            // espace bougent : un id étranger est ignoré en silence. `updated` ne
            // bouge pas, réordonner n'est pas modifier.
            for (let i = 0; i < projectIds.length; i++) {
                await q.execute('UPDATE projects SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    projectIds[i],
                    workspaceId
                ]);
            }
        },
        async statsFor(projectIds, userId, now) {
            if (projectIds.length === 0) return [];
            // Une seule requête pour tout le portefeuille, qui affiche plusieurs
            // dizaines de projets. Par identifiant et non par espace : un projet
            // projeté ici vit ailleurs, ses compteurs se lisent pareil.
            //
            // Les non-lus se comptent contre le point d'eau haute de l'appelant ; une
            // carte jamais ouverte n'a pas de ligne, d'où le COALESCE à 0 qui compte
            // alors tous ses messages.
            const placeholders = projectIds.map(() => '?').join(', ');
            const rows = await q.query<ProjectStats>(
                `SELECT p.id AS project_id,
                        COUNT(c.id)                                             AS card_total,
                        COALESCE(SUM(col.counts_as_done), 0)                    AS card_done,
                        COALESCE(SUM(c.due_date IS NOT NULL
                                     AND c.due_date < ?
                                     AND col.counts_as_done = 0), 0)            AS card_overdue,
                        MIN(CASE WHEN c.due_date >= ? AND col.counts_as_done = 0
                                 THEN c.due_date END)                           AS next_due_date,
                        COALESCE(SUM(GREATEST(
                            c.message_count - COALESCE(seen.seen_count, 0), 0)), 0) AS unread
                 FROM projects p
                 LEFT JOIN project_cards c
                        ON c.project_id = p.id AND c.archived_at IS NULL
                 LEFT JOIN project_columns col
                        ON col.id = c.column_id
                 LEFT JOIN (
                        SELECT m.card_id, COUNT(*) AS seen_count
                        FROM project_messages m
                        JOIN project_card_reads r
                          ON r.card_id = m.card_id AND r.user_id = ?
                        WHERE m.id <= r.last_read_message_id
                        GROUP BY m.card_id
                 ) seen ON seen.card_id = c.id
                 WHERE p.id IN (${placeholders}) AND p.archived_at IS NULL
                 GROUP BY p.id`,
                [now, now, userId, ...projectIds]
            );
            return rows.map((row) => ({
                project_id: Number(row.project_id),
                card_total: Number(row.card_total),
                card_done: Number(row.card_done),
                card_overdue: Number(row.card_overdue),
                next_due_date: row.next_due_date === null ? null : Number(row.next_due_date),
                unread: Number(row.unread)
            }));
        }
    };
}
