import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECTS_USAGE_PROVIDER } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { projectsHandlers } from './handlers';
import { createRepo, type ProjectsRepo } from './repo';
import { createProjectsUsageProvider } from './usageProvider';

/**
 * L'entrée serveur du module.
 *
 * `createService` ne fait tourner aucune boucle : rien de Projets ne travaille
 * en fond (la synchronisation des dépôts et le suivi des déploiements sont
 * les services des modules Git et Déploiement). Il ne sert qu'à PUBLIER le
 * contrat que les autres modules lisent (`PROJECTS_USAGE_PROVIDER`, l'ex
 * `registerNativeProvider` d'`app.ts`) : les projets qui relient un élément,
 * combien par élément, la frise d'un projet pour un déploiement parti de son
 * onglet, la version d'un projet qui suit les releases d'un dépôt. Les
 * modules Bases de données, Déploiement, Git et Audience le lisent par
 * `providers.get`, comme avant.
 *
 * Dans l'autre sens, Projets consomme leurs contrats d'éléments
 * (`*_ITEMS_PROVIDER`) par `ctx.providers` avant de poser une liaison.
 *
 * Pas d'entrée `items` : le manifest déclare `shareTier: 'never'` par-dessus
 * le `'perItem'` du descripteur publié, parce que le listage n'est pas
 * branché sur le partage (voir `manifest.ts`). Le jour où il l'est, `items`
 * arrive ici en même temps que `ctx.sharing.scope()` dans `projects.list`.
 *
 * `migrationsDir` : les treize tables du module datent du socle (060, 061 et
 * leurs suites, jamais déplacées, allowlist dans deveye-feature.json) ; la
 * seule migration du module (`001`) renomme les genres d'événements stockés
 * (`project.*` → `projects.*`, le préfixe du module), sur une table de
 * l'allowlist. Une nouvelle table prendra le préfixe `ft_projects_`. Pas
 * d'`uninstall.sql` : le module ne possède aucune table à lui, et le SQL de
 * démontage ne peut pas toucher aux tables historiques (comme Mail).
 */
export const serverEntry: FeatureServer<ProjectsRepo> = {
    createRepo,
    features: projectsHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService(deps) {
        return {
            start() {},
            stop() {},
            providers: { [PROJECTS_USAGE_PROVIDER]: createProjectsUsageProvider(deps) }
        };
    }
};
