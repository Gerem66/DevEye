import type { ProjectVersionSource } from '../contracts/domain';
import { type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { ProjectsRepo, ProjectUsageRow } from './repo';
import { encryptProject, tryDecryptProject, type StoredEvent } from './_shared';

/**
 * Ce que les autres modules demandent à Projets (`PROJECTS_USAGE_PROVIDER`),
 * publié par le service de ce module : pour un élément d'une autre feature
 * (une base de données, une cible de déploiement, un dépôt git, un site
 * suivi), les projets de l'espace qui le relient, avec leur titre, et combien
 * en relient chacun. C'est ce qui rend l'interconnexion cliquable dans les
 * deux sens sans qu'un module lise une table de Projets. Et, dans l'autre
 * sens, les deux seules choses qu'un module ait à DIRE à un projet : une ligne
 * de frise (un déploiement déclenché depuis l'onglet d'un projet), et la
 * version que porte un élément (la dernière release d'un dépôt, pour les
 * projets qui ont demandé à la suivre).
 *
 * Les modules le lisent par `providers.get` sans savoir qui l'offre : l'app
 * l'offrait tant que Projets était native, le service publie la même clé, et
 * rien n'a changé de leur côté.
 *
 * Tout ici travaille **sans session**, à l'étage ouvert (`deps.cipherFor`,
 * mémoïsé par l'hôte) : un projet gardé ne se relie pas, donc n'a rien à
 * rendre ni à recevoir par ce contrat.
 */

/** Ce que le contrat lit du dépôt et de l'hôte : pas le service entier. */
type Deps = Pick<FeatureServiceDeps<ProjectsRepo>, 'repo' | 'cipherFor' | 'live'>;

/**
 * Une table de liaison par feature reliée, explicite plutôt que dynamique :
 * chaque feature range ses liaisons dans sa propre table de Projets, et une
 * résolution par nom construirait une requête à partir d'une entrée. Une
 * feature absente d'ici ne relie rien : vide, jamais une erreur. Uptime s'y
 * ajoutera le jour où ses liaisons passeront par ce contrat.
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
 * La source de version qu'un projet doit avoir choisie pour suivre les
 * versions d'une feature reliée. La règle est celle de Projets, pas celle du
 * module : `github_release` est la seule source suivie aujourd'hui, et elle
 * vaut pour la feature `git` (la dernière release d'un dépôt lié). Une feature
 * absente d'ici n'a pas de version à reporter : rien n'est écrit.
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
            // Tous à l'étage ouvert (la requête le garantit), donc lisibles
            // sans session ; un corps illisible garde le projet dans la liste,
            // sous un titre de secours.
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
            // Un projet gardé n'a pas de déploiement (sa liaison est refusée) :
            // s'il s'en présente un, c'est qu'on regarde le mauvais projet. Et
            // l'étage ouvert est le seul que ce contrat sache écrire sans
            // session : la frise d'un projet gardé vit sous sa clé.
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
            // La frise ouverte de ce projet doit suivre : le module qui écrit
            // (`deploy.trigger`) ne bat que son sujet, celui-ci est le nôtre.
            deps.live.changed(workspaceId);
        },
        /**
         * Reporte une version sur les projets qui ont demandé à la suivre. Le
         * champ devient alors piloté par l'élément, et l'interface le passe en
         * lecture seule. L'ex `applyReleaseVersion` du service git natif, côté
         * Projets : le module dit la version, Projets décide qui la suit.
         *
         * **Tous** les projets liés de l'espace, et non un seul : un dépôt sert
         * plusieurs projets, et n'en servir qu'un serait arbitraire. La liste
         * est courte, et déjà filtrée sur l'étage ouvert (la liaison d'un
         * projet gardé est refusée), donc lisible et réécrite sans session.
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
            // Le sujet `projects`, que le service git natif battait après un
            // tour qui avait changé une version : le module Git ne nomme que
            // le sien, c'est donc Projets qui ravive son portefeuille. Jamais
            // sans changement, une release déjà reportée ne réveille personne.
            if (changed) deps.live.changed(workspaceId);
        }
    };
}
