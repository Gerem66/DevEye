import type { ProjectPublicRow, ProjectRow } from '../../contracts/domain';
import { publicStockId, type ProjectPublicationRepo } from '../repo';

/** Une ligne telle que la table la garde : l'espace et le palier se lisent sur le projet. */
export type StoredPublication = Omit<ProjectPublicRow, 'workspace_id' | 'security_tier'>;

export interface MemoryPublicationRepo extends ProjectPublicationRepo {
    rows: StoredPublication[];
}

/**
 * Le dépôt de la page publique en mémoire, sur les projets que le test tient :
 * la même jointure que le SQL, donc un projet disparu emporte sa publication.
 */
export function memoryPublicationRepo(projects: () => readonly ProjectRow[]): MemoryPublicationRepo {
    const rows: StoredPublication[] = [];
    const joined = (row: StoredPublication): ProjectPublicRow | null => {
        const project = projects().find((p) => p.id === row.project_id);
        return project ? { ...row, workspace_id: project.workspace_id, security_tier: project.security_tier } : null;
    };
    const all = () => rows.map(joined).filter((row): row is ProjectPublicRow => row !== null);
    const live = (domainId: number) =>
        all()
            .filter((row) => row.domain_id === domainId && row.enabled === 1)
            .sort((a, b) => (a.domain_at ?? 0) - (b.domain_at ?? 0) || a.project_id - b.project_id);

    return {
        rows,
        find: async (projectId, workspaceId) =>
            all().find((row) => row.project_id === projectId && row.workspace_id === workspaceId) ?? null,
        findByRef: async (ref) => all().find((row) => row.public_ref === ref) ?? null,
        findBySlug: async (domainId, slug) => live(domainId).find((row) => row.slug === slug) ?? null,
        listOnDomain: async (domainId) => live(domainId),
        slugsOn: async (domainId, exceptProjectId) =>
            rows
                .filter((row) => row.domain_id === domainId && row.project_id !== exceptProjectId && row.slug !== null)
                .map((row) => row.slug as string),
        countEnabledIn: async (ids) =>
            all().filter((row) => row.enabled === 1 && ids.includes(row.workspace_id)).length,
        listStock: async (ids) =>
            all()
                .filter((row) => row.enabled === 1 && ids.includes(row.workspace_id))
                .sort((a, b) => (a.published_at ?? 0) - (b.published_at ?? 0) || a.project_id - b.project_id)
                .map((row) => ({ id: publicStockId(row.project_id), workspaceId: row.workspace_id })),
        async save(projectId, publicRef, config) {
            const next: StoredPublication = {
                project_id: projectId,
                public_ref: publicRef,
                enabled: config.enabled ? 1 : 0,
                published_at: config.publishedAt,
                domain_id: config.domainId,
                slug: config.slug,
                domain_at: config.domainAt,
                show_dates: config.showDates ? 1 : 0,
                show_assignees: config.showAssignees ? 1 : 0,
                show_subtasks: config.showSubtasks ? 1 : 0,
                theme: config.theme,
                accent: config.accent,
                created: rows.find((row) => row.project_id === projectId)?.created ?? 1
            };
            const clash = rows.find(
                (row) =>
                    row.project_id !== projectId &&
                    (row.public_ref === publicRef ||
                        (next.domain_id !== null && row.domain_id === next.domain_id && row.slug === next.slug))
            );
            if (clash) throw new Error('Duplicate entry');
            const index = rows.findIndex((row) => row.project_id === projectId);
            if (index >= 0) rows[index] = next;
            else rows.push(next);
        },
        async remove(projectId) {
            const index = rows.findIndex((row) => row.project_id === projectId);
            if (index < 0) return false;
            rows.splice(index, 1);
            return true;
        },
        async domainUse(workspaceId) {
            const use = new Map<number, number>();
            for (const row of all()) {
                if (row.workspace_id !== workspaceId || row.domain_id === null) continue;
                use.set(row.domain_id, (use.get(row.domain_id) ?? 0) + 1);
            }
            return use;
        },
        async clearDomain(domainId, workspaceId) {
            for (const row of rows) {
                if (row.domain_id !== domainId || joined(row)?.workspace_id !== workspaceId) continue;
                row.domain_id = null;
                row.slug = null;
                row.domain_at = null;
            }
        }
    };
}
