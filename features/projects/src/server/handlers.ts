import type { ZodType } from 'zod';

import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import { projectAudienceLinkFeatures } from './audienceLink';
import { projectBoardFeatures } from './board';
import { projectChatFeatures } from './chat';
import { projectDatabaseLinkFeatures } from './databaseLink';
import { projectDeployLinkFeatures } from './deployLink';
import { projectHistoryFeatures } from './history';
import { projectLinkFeatures } from './links';
import { projectPortfolioFeatures } from './projects';
import type { ProjectsRepo } from './repo';
import { projectRepoLinkFeatures } from './repoLink';
import { projectTimelineFeatures } from './timeline';

/**
 * Les cinquante et une commandes du module, réparties par sous-domaine
 * (portefeuille, tableau, discussion, frise, historique, liaisons). Same
 * grouping as `projectCommands` in the contract, so the two lists diff
 * against each other.
 *
 * ⚠️ Toutes en camelCase derrière `projects.` : le filet de démarrage de
 * l'app (`MUTATION_VERB` dans `_topics.ts`) n'en voit aucune, et un `mutates`
 * oublié ne produirait aucun avertissement. `handlers.test.ts` relit donc la
 * déclaration de chaque écriture à la place du filet.
 */
export const projectsHandlers: readonly SdkFeatureDefinition<ProjectsRepo, string, ZodType, ZodType>[] = [
    ...projectPortfolioFeatures,
    ...projectBoardFeatures,
    ...projectChatFeatures,
    ...projectTimelineFeatures,
    ...projectHistoryFeatures,
    ...projectRepoLinkFeatures,
    ...projectDeployLinkFeatures,
    ...projectLinkFeatures,
    ...projectDatabaseLinkFeatures,
    ...projectAudienceLinkFeatures
];
