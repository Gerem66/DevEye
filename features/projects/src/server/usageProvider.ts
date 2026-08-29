import type { ProjectVersionSource } from '../contracts/domain';
import { type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { ProjectsRepo, ProjectUsageRow } from './repo';
import { encryptProject, tryDecryptProject, type StoredEvent } from './_shared';

/**
 * Ce que les autres modules demandent à Projets (`PROJECTS_USAGE_PROVIDER`) : pour
 * un élément d'une autre feature, les projets de l'espace qui le relient, avec leur
 * titre, et combien en relient chacun, ce qui rend l'interconnexion cliquable dans
 * les deux sens sans qu'un module lise une table de Projets. Et dans l'autre sens,
 * les deux seules choses qu'un module ait à dire à un projet : une ligne de frise et
 * la version que porte un élément.
 *
 * Tout ici travaille sans session, à l'étage ouvert (`deps.cipherFor`) : un projet
 * gardé ne se relie pas, il n'a donc rien à rendre ni à recevoir par ce contrat.
 *
 * Rien à savoir des projections : une liaison ne se pose qu'au domicile du projet,
 * vers un élément du même espace, et c'est cet espace que les modules passent ici.
 * `findById`, le domicile seul et jamais une fenêtre, suffit donc.
 */

/** Ce que le contrat lit du dépôt et de l'hôte : pas le service entier. */
type Deps = Pick<FeatureServiceDeps<ProjectsRepo>, 'repo' | 'cipherFor' | 'live'>;

/**
 * Une table de liaison par feature reliée, explicite plutôt que dynamique : une
 * résolution par nom construirait une requête à partir d'une entrée. Une feature
 * absente d'ici ne relie rien, ce qui rend du vide et jamais une erreur.
 */
const LINKS: Record<
    string,
    {
        usage(repo: ProjectsRepo, itemId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
        counts(repo: ProjectsRepo, workspaceId: number): Promise<Map<number, number>>;
    }
> = {
    database: {
        usage: (repo, itemId, workspaceId) => repo.links.listDatabaseUsage(itemId, workspaceId),
        counts: (repo, workspaceId) => repo.links.countDatabaseLinks(workspaceId)
    },
    deploy: {
        usage: (repo, itemId, workspaceId) => repo.links.listDeployUsage(itemId, workspaceId),
        counts: (repo, workspaceId) => repo.links.countDeployLinks(workspaceId)
    },
    git: {
        usage: (repo, itemId, workspaceId) => repo.links.listRepoUsage(itemId, workspaceId),
        counts: (repo, workspaceId) => repo.links.countRepoLinks(workspaceId)
    },
    audience: {
        usage: (repo, itemId, workspaceId) => repo.links.listSiteUsage(itemId, workspaceId),
        counts: (repo, workspaceId) => repo.links.countSiteLinks(workspaceId)
    }
};

/**
 * La source de version qu'un projet doit avoir choisie pour suivre les versions
 * d'une feature reliée. La règle est celle de Projets, pas celle du module ; une
 * feature absente d'ici n'a pas de version à reporter, rien n'est écrit.
 */
const VERSION_SOURCE_OF: Record<string, ProjectVersionSource> = {
    git: 'github_release'
};

export function createProjectsUsageProvider(deps: Deps): ProjectsUsageProvider {
    return {
        async usageOf(feature, itemId, workspaceId) {
            const link = LINKS[feature];
            if (!link) return [];
            const rows = await link.usage(deps.repo, itemId, workspaceId);
            const cipher = deps.cipherFor(workspaceId);
            // Tous à l'étage ouvert, la requête le garantit, donc lisibles sans
            // session ; un corps illisible garde le projet, sous un titre de secours.
            return Promise.all(
                rows.map(async (row): Promise<ProjectUsage> => ({
                    projectId: row.project_id,
                    title: (await tryDecryptProject(cipher, row.content))?.title || 'Sans titre',
                    status: row.status
                }))
            );
        },
        async countByItem(feature, workspaceId) {
            const link = LINKS[feature];
            if (!link) return new Map<number, number>();
            return link.counts(deps.repo, workspaceId);
        },
        async recordEvent(projectId, workspaceId, event) {
            const project = await deps.repo.projects.findById(projectId, workspaceId);
            // L'étage ouvert est le seul que ce contrat sache écrire sans session,
            // et un projet gardé n'a de toute façon aucune liaison.
            if (!project || project.security_tier !== 'open') return;
            const payload: StoredEvent = { label: event.label, from: null, to: null };
            await deps.repo.history.record({
                projectId,
                workspaceId,
                actorUserId: event.actorUserId,
                kind: event.kind,
                refType: null,
                refId: null,
                content: await deps.cipherFor(workspaceId).encrypt(JSON.stringify(payload))
            });
            // Le module qui écrit ne bat que son sujet : la frise du projet ne
            // suivrait pas sans cela.
            deps.live.changed(workspaceId);
        },
        /**
         * Reporte une version sur les projets qui ont demandé à la suivre : le module
         * dit la version, Projets décide qui la suit. Tous les projets liés de
         * l'espace, un dépôt en servant plusieurs ; la liste est courte et déjà
         * filtrée sur l'étage ouvert, donc lisible et réécrite sans session.
         */
        async applyVersion(feature, itemId, workspaceId, version) {
            const link = LINKS[feature];
            const source = VERSION_SOURCE_OF[feature];
            if (!link || !source) return;
            const usage = await link.usage(deps.repo, itemId, workspaceId);
            if (usage.length === 0) return;

            const cipher = deps.cipherFor(workspaceId);
            let changed = false;
            for (const row of usage) {
                const project = await deps.repo.projects.findById(row.project_id, workspaceId);
                if (!project || project.security_tier !== 'open' || project.version_source !== source) continue;

                const body = await tryDecryptProject(cipher, project.content);
                if (!body || body.version === version) continue;

                await deps.repo.projects.update(project.id, workspaceId, {
                    status: project.status,
                    startDate: project.start_date,
                    dueDate: project.due_date,
                    content: await encryptProject(cipher, { ...body, version })
                });
                changed = true;
            }
            // Le module Git ne bat que son propre sujet : c'est à Projets de raviver
            // son portefeuille. Jamais sans changement, une release déjà reportée ne
            // réveille personne.
            if (changed) deps.live.changed(workspaceId);
        }
    };
}
