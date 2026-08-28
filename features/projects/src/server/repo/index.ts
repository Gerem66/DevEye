import type { SdkQueryable } from '@deveye/types/sdk/server';

import { projectBoardRepo, type ProjectBoardRepo } from './board';
import { projectChatRepo, type ProjectChatRepo } from './chat';
import { projectHistoryRepo, type ProjectHistoryRepo } from './history';
import { projectLinksRepo, type ProjectLinksRepo } from './links';
import { projectPlanRepo, type ProjectPlanRepo } from './plan';
import { projectRepo, type ProjectRepo } from './projects';
import { projectRekeyRepo, type ProjectRekeyRepo } from './rekey';

export type { CardUnread } from './board';
export type { ProjectUsageRow } from './links';
export type { ProjectStats } from './projects';
export type { ProjectEncryptedCell } from './rekey';
export type { ProjectBoardRepo, ProjectChatRepo, ProjectHistoryRepo, ProjectLinksRepo, ProjectPlanRepo, ProjectRepo };
export type { ProjectRekeyRepo };

/**
 * Le dépôt du module : les sept dépôts natifs (`db.projects`,
 * `db.projectBoard`, `db.projectChat`, `db.projectPlan`, `db.projectHistory`,
 * `db.projectLinks`, `db.projectRekey`) réunis en un seul contrat sur
 * `SdkQueryable`, un fichier par agrégat comme avant le rapatriement, sections
 * gardées parce que leurs verbes se répètent d'une table à l'autre (`findById`,
 * `reorder`, `archive`). Les treize tables `project*` datent du socle (060,
 * 061 et leurs suites, jamais déplacées) : l'allowlist de `deveye-feature.json`
 * les dispense du préfixe `ft_projects_`.
 *
 * Les dépôts ne chiffrent jamais : les handlers passent des valeurs déjà
 * scellées par `ctx.cipher(...)`, le service par `deps.cipherFor(ws)`.
 */
export interface ProjectsRepo {
    projects: ProjectRepo;
    board: ProjectBoardRepo;
    chat: ProjectChatRepo;
    plan: ProjectPlanRepo;
    history: ProjectHistoryRepo;
    links: ProjectLinksRepo;
    rekey: ProjectRekeyRepo;
}

export function createRepo(q: SdkQueryable): ProjectsRepo {
    return {
        projects: projectRepo(q),
        board: projectBoardRepo(q),
        chat: projectChatRepo(q),
        plan: projectPlanRepo(q),
        history: projectHistoryRepo(q),
        links: projectLinksRepo(q),
        rekey: projectRekeyRepo(q)
    };
}
