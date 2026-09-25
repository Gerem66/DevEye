import type { SdkQueryable } from '@deveye/types/sdk/server';

import { projectBoardRepo, type ProjectBoardRepo } from './board';
import { projectChatRepo, type ProjectChatRepo } from './chat';
import { projectDashboardRepo, type ProjectDashboardRepo } from './dashboard';
import { projectHistoryRepo, type ProjectHistoryRepo } from './history';
import { projectLinksRepo, type ProjectLinksRepo } from './links';
import { projectPlanRepo, type ProjectPlanRepo } from './plan';
import { projectRepo, type ProjectRepo } from './projects';
import { projectPublicationRepo, type ProjectPublicationRepo } from './publication';
import { projectRekeyRepo, type ProjectRekeyRepo } from './rekey';

export type { CardUnread } from './board';
export type { ProjectUsageRow } from './links';
export type { ProjectStats } from './projects';
export type { ProjectEncryptedCell } from './rekey';
export { publicStockId, type ProjectPublicationConfig } from './publication';
export type {
    ProjectBoardRepo,
    ProjectChatRepo,
    ProjectDashboardRepo,
    ProjectHistoryRepo,
    ProjectLinksRepo,
    ProjectPlanRepo,
    ProjectPublicationRepo,
    ProjectRepo
};
export type { ProjectRekeyRepo };

/**
 * Le dépôt du module : un fichier par agrégat, réunis en un seul contrat sur
 * `SdkQueryable`. Les treize tables `project*` datent du socle, l'allowlist de
 * `deveye-feature.json` les dispense du préfixe `ft_projects_` ; celles de la vue
 * d'ensemble et de la page publique, propres au module, le portent.
 *
 * Les dépôts ne chiffrent jamais : les handlers passent des valeurs déjà scellées
 * par `ctx.cipher(...)`, le service par `deps.cipherFor(ws)`.
 */
export interface ProjectsRepo {
    projects: ProjectRepo;
    board: ProjectBoardRepo;
    chat: ProjectChatRepo;
    plan: ProjectPlanRepo;
    history: ProjectHistoryRepo;
    links: ProjectLinksRepo;
    dashboard: ProjectDashboardRepo;
    rekey: ProjectRekeyRepo;
    publication: ProjectPublicationRepo;
}

export function createRepo(q: SdkQueryable): ProjectsRepo {
    return {
        projects: projectRepo(q),
        board: projectBoardRepo(q),
        chat: projectChatRepo(q),
        plan: projectPlanRepo(q),
        history: projectHistoryRepo(q),
        links: projectLinksRepo(q),
        dashboard: projectDashboardRepo(q),
        rekey: projectRekeyRepo(q),
        publication: projectPublicationRepo(q)
    };
}
