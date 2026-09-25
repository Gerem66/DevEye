import type { ProjectPublicRow } from '../../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

/**
 * L'identifiant d'une page publique dans le stock de l'offre. Pas celui du
 * projet : un déplacement vérifie l'offre de la cible pour les éléments qui le
 * suivent, et la page publique, elle, ne suit pas.
 */
export function publicStockId(projectId: number): string {
    return `public:${projectId}`;
}

/** Ce qu'une écriture pose sur la page publique d'un projet. */
export interface ProjectPublicationConfig {
    enabled: boolean;
    publishedAt: number | null;
    domainId: number | null;
    slug: string | null;
    domainAt: number | null;
    showDates: boolean;
    showAssignees: boolean;
}

/**
 * La table `ft_projects_public` : une ligne par projet publié au moins une fois.
 * L'espace et le palier se lisent sur `projects`, jamais recopiés : ce sont eux
 * que les gardes de la page publique comparent.
 */
export interface ProjectPublicationRepo {
    /** La publication d'un projet de cet espace, en ligne ou non. */
    find(projectId: number, workspaceId: number): Promise<ProjectPublicRow | null>;
    findByRef(publicRef: string): Promise<ProjectPublicRow | null>;
    /** Un projet en ligne sous ce chemin de ce domaine. */
    findBySlug(domainId: number, slug: string): Promise<ProjectPublicRow | null>;
    /** Les projets en ligne sur ce domaine, le plus ancien sur ce nom d'abord : la racine revient au premier servi. */
    listOnDomain(domainId: number): Promise<ProjectPublicRow[]>;
    /** Les chemins déjà pris sur ce domaine, hors ce projet. */
    slugsOn(domainId: number, exceptProjectId: number): Promise<string[]>;
    countEnabledIn(workspaceIds: readonly number[]): Promise<number>;
    /** Ce que `countEnabledIn` compte, les plus anciennes mises en ligne d'abord : l'offre sert celles de tête. */
    listStock(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    /** Crée la ligne au premier appel, avec son lien ; la réécrit ensuite, lien compris. */
    save(projectId: number, publicRef: string, config: ProjectPublicationConfig): Promise<void>;
    remove(projectId: number): Promise<boolean>;
    /** Combien de projets de l'espace chaque domaine sert. */
    domainUse(workspaceId: number): Promise<Map<number, number>>;
    clearDomain(domainId: number, workspaceId: number): Promise<void>;
}

const SELECT = `SELECT pub.*, p.workspace_id, p.security_tier
                  FROM ft_projects_public pub
                  JOIN projects p ON p.id = pub.project_id`;

export function projectPublicationRepo(q: SdkQueryable): ProjectPublicationRepo {
    const one = async (where: string, params: unknown[]) =>
        (await q.query<ProjectPublicRow>(`${SELECT} WHERE ${where} LIMIT 1`, params))[0] ?? null;

    return {
        find: (projectId, workspaceId) => one('pub.project_id = ? AND p.workspace_id = ?', [projectId, workspaceId]),
        findByRef: (publicRef) => one('pub.public_ref = ?', [publicRef]),
        findBySlug: (domainId, slug) => one('pub.domain_id = ? AND pub.slug = ? AND pub.enabled = 1', [domainId, slug]),
        listOnDomain: (domainId) =>
            q.query<ProjectPublicRow>(
                `${SELECT} WHERE pub.domain_id = ? AND pub.enabled = 1 ORDER BY pub.domain_at ASC, pub.project_id ASC`,
                [domainId]
            ),
        async slugsOn(domainId, exceptProjectId) {
            const rows = await q.query<{ slug: string }>(
                'SELECT slug FROM ft_projects_public WHERE domain_id = ? AND project_id <> ? AND slug IS NOT NULL',
                [domainId, exceptProjectId]
            );
            return rows.map((row) => row.slug);
        },
        async countEnabledIn(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_projects_public pub JOIN projects p ON p.id = pub.project_id
                  WHERE pub.enabled = 1 AND p.workspace_id IN (?)`,
                [[...workspaceIds]]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async listStock(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ project_id: number; workspace_id: number }>(
                `SELECT pub.project_id, p.workspace_id FROM ft_projects_public pub JOIN projects p ON p.id = pub.project_id
                  WHERE pub.enabled = 1 AND p.workspace_id IN (?)
                  ORDER BY pub.published_at ASC, pub.project_id ASC`,
                [[...workspaceIds]]
            );
            return rows.map((row) => ({ id: publicStockId(row.project_id), workspaceId: Number(row.workspace_id) }));
        },
        async save(projectId, publicRef, config) {
            const values = [
                config.enabled ? 1 : 0,
                config.publishedAt,
                config.domainId,
                config.slug,
                config.domainAt,
                config.showDates ? 1 : 0,
                config.showAssignees ? 1 : 0
            ];
            await q.execute(
                `INSERT INTO ft_projects_public
                     (project_id, public_ref, enabled, published_at, domain_id, slug, domain_at, show_dates, show_assignees)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE public_ref = VALUES(public_ref), enabled = VALUES(enabled),
                     published_at = VALUES(published_at), domain_id = VALUES(domain_id), slug = VALUES(slug),
                     domain_at = VALUES(domain_at), show_dates = VALUES(show_dates),
                     show_assignees = VALUES(show_assignees)`,
                [projectId, publicRef, ...values]
            );
        },
        async remove(projectId) {
            const res = await q.execute('DELETE FROM ft_projects_public WHERE project_id = ?', [projectId]);
            return res.affectedRows > 0;
        },
        async domainUse(workspaceId) {
            const rows = await q.query<{ domain_id: number; n: number }>(
                `SELECT pub.domain_id, COUNT(*) AS n FROM ft_projects_public pub JOIN projects p ON p.id = pub.project_id
                  WHERE p.workspace_id = ? AND pub.domain_id IS NOT NULL GROUP BY pub.domain_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.domain_id), Number(row.n)]));
        },
        async clearDomain(domainId, workspaceId) {
            await q.execute(
                `UPDATE ft_projects_public pub JOIN projects p ON p.id = pub.project_id
                    SET pub.domain_id = NULL, pub.slug = NULL, pub.domain_at = NULL
                  WHERE pub.domain_id = ? AND p.workspace_id = ?`,
                [domainId, workspaceId]
            );
        }
    };
}
