import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECTS_USAGE_PROVIDER } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { projectsHandlers } from './handlers';
import { projectsMove } from './move';
import { createRepo, type ProjectsRepo } from './repo';
import { tryDecryptProject } from './_shared';
import { createProjectsUsageProvider } from './usageProvider';

/**
 * L'entrée serveur du module. `createService` ne fait tourner aucune boucle : rien
 * de Projets ne travaille en fond, il ne sert qu'à publier le contrat que les
 * modules Bases de données, Déploiement, Git et Audience lisent par `providers.get`
 * (`PROJECTS_USAGE_PROVIDER` : les projets qui relient un élément, la frise où
 * inscrire un déploiement, la version qui suit les releases d'un dépôt). Dans
 * l'autre sens, Projets consomme leurs contrats d'éléments (`*_ITEMS_PROVIDER`) :
 * `exists` avant de poser une liaison, `labelOf` pour nommer celles qui existent.
 *
 * `items` est ce que le partage sait des projets sans ouvrir la feature
 * (`Docs/SHARING.md`) ; `shareTier: 'perItem'` l'exige, le boot refuse un module qui
 * déclare sans l'offrir.
 *
 * Les treize tables du module datent du socle et l'allowlist de
 * `deveye-feature.json` les dispense du préfixe `ft_projects_`. `uninstall.sql`
 * ne détruit que ce que le module possède vraiment, la table de la vue
 * d'ensemble : le SQL de démontage ne peut pas toucher aux tables historiques.
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
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.projects.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        // Le titre vit dans le blob chiffré : un projet gardé, que le codec ouvert
        // ne sait pas lire, un blob illisible ou un projet disparu valent `null`.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.projects.findById(Number(itemId), workspaceId);
            if (!row || row.security_tier !== 'open') return null;
            const payload = await tryDecryptProject(cipher, row.content);
            if (!payload) return null;
            return payload.title.length > 0 ? payload.title : 'Sans titre';
        },
        // Seul un projet ouvert se lit sous une clé que le serveur tient seul, donc
        // depuis un autre espace : projeter un projet gardé ouvrirait une fenêtre
        // sur rien, et `share.set` refuse en le disant.
        shareable: async (repo, itemId, workspaceId) =>
            (await repo.projects.findById(Number(itemId), workspaceId))?.security_tier === 'open',
        move: projectsMove
    }
};
