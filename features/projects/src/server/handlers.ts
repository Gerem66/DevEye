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
 * Les commandes du module, groupées par sous-domaine dans le même ordre que
 * `projectCommands` côté contrat, pour que les deux listes se comparent.
 *
 * ⚠️ Toutes en camelCase derrière `projects.` : le filet de démarrage de l'app
 * (`MUTATION_VERB` dans `_topics.ts`) n'en voit aucune, et un `mutates` oublié ne
 * produirait aucun avertissement. `handlers.test.ts` relit chaque écriture à sa
 * place.
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
