import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECTS_USAGE_PROVIDER } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { projectsHandlers } from './handlers';
import { createRepo, type ProjectsRepo } from './repo';
import { tryDecryptProject } from './_shared';
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
 * (`*_ITEMS_PROVIDER`) par `ctx.providers` : `exists` avant de poser une
 * liaison, `labelOf` pour nommer celles qui existent.
 *
 * `items` est ce que le partage sait des projets sans ouvrir la feature
 * (`Docs/SHARING.md`) : le domicile d'un projet visible d'ici (le sien, ou
 * l'espace qui le projette), son titre déchiffré par le codec ouvert de
 * l'espace appelant, et son palier (`shareable` : un projet ouvert se
 * projette, un projet gardé est chiffré par le mot de passe de son auteur et
 * ne se lit nulle part ailleurs). `shareTier: 'perItem'`, hérité du
 * descripteur, l'exige ; le boot refuse un module qui déclare sans l'offrir.
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
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.projects.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        // Le titre vit dans le blob chiffré ; un projet gardé (étage gardé, que
        // le codec ouvert ne sait pas lire), un blob illisible ou un projet
        // disparu valent `null`. Le titre vide se nomme comme partout à
        // l'écran. Demandé avec le domicile du projet.
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.projects.findById(itemId, workspaceId);
            if (!row || row.security_tier !== 'open') return null;
            const payload = await tryDecryptProject(cipher, row.content);
            if (!payload) return null;
            return payload.title.length > 0 ? payload.title : 'Sans titre';
        },
        // Le palier, projet par projet : seul un projet ouvert se lit sous une
        // clé que le serveur tient seul, donc dans un autre espace. Projeter un
        // projet gardé ouvrirait une fenêtre sur rien ; `share.set` refuse en
        // le disant. Demandé avec le domicile du projet.
        shareable: async (repo, itemId, workspaceId) =>
            (await repo.projects.findById(itemId, workspaceId))?.security_tier === 'open'
    }
};
