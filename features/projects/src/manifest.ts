import { featureDescriptor } from '@deveye/types';

import { projectCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Deux sujets, parce qu'un fil de discussion change à une tout autre cadence que
 * la structure qui le porte : sans `projectsChat`, chaque message ferait
 * re-solliciter le tableau, la frise et le portefeuille entiers.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier`) reste celui du registre publié, étalé plutôt que recopié ; le
 * manifest n'ajoute que ce que le registre ne porte pas. `shareTier: 'perItem'`
 * engage le module : l'entrée `items` de `server/index.ts`, `ctx.sharing.scope()`
 * dans ses listages, et un codec choisi projet par projet (`Docs/SHARING.md`).
 */
const descriptor = featureDescriptor('projects');

export const manifest = {
    ...descriptor,
    category: 'work',
    links: [
        { to: 'git', what: 'suit les dépôts du projet' },
        { to: 'deploy', what: 'suit ses cibles de mise en production' },
        { to: 'database', what: "suit les bases qu'il utilise" },
        { to: 'audience', what: "suit les sites qu'il produit" },
        { to: 'uptime', what: "suit les services qu'il fait tourner" }
    ],
    /**
     * Le détail ouvert (tableau, frise, liaisons, historique) tient dans une seule
     * clé : ils se relisent ensemble. Le sujet `projects` ravive les quatre
     * premières ; `projectsChat` les messages et le portefeuille, pour ses
     * compteurs de non-lus.
     */
    resources: ['projects.count', 'projects.list', 'projects.board', 'projects.myTasks', 'projects.messages'],
    invalidatedByTopic: ['projects.count', 'projects.list', 'projects.board', 'projects.myTasks'],
    topics: [{ id: 'projectsChat', keys: ['projects.messages', 'projects.list'] }],
    /** Les assignés d'une carte et les auteurs d'un message sont des membres. */
    nativeCapabilities: ['members.read'],
    /**
     * `write` seul laisse participer au tableau : retoucher une tâche et la
     * faire passer d'une colonne à l'autre. Les cinq droits ci-dessous
     * gouvernent des surfaces distinctes du projet, orthogonales entre elles :
     * son existence, ses tâches, son calendrier, ses rattachements, sa
     * conversation. Confier l'exécution sans confier la planification est le
     * cas qui les a fait naître. Chacun se surcharge projet par projet, par
     * l'onglet Permissions de sa fiche.
     */
    extraPermissions: [
        {
            key: 'manageProjects',
            label: 'Gérer les projets',
            description:
                'Créer, renommer, archiver, restaurer et classer un projet, poser son statut, sa version et son palier de confidentialité, et tenir les colonnes de son tableau.',
            type: 'toggle'
        },
        {
            key: 'tasks',
            label: 'Créer et archiver des tâches',
            description:
                'Ajouter une tâche au tableau, l’archiver, la restaurer. Sans ce droit, l’écriture permet toujours de modifier celles qui existent et de les déplacer.',
            type: 'toggle'
        },
        {
            key: 'plan',
            label: 'Modifier la planification',
            description:
                'Poser et déplacer les dates sur la frise, tenir les jalons et les dépendances. Sans ce droit, chacun date toujours les tâches qui lui reviennent.',
            type: 'toggle'
        },
        {
            key: 'links',
            label: 'Gérer les liaisons',
            description:
                'Rattacher le projet à un dépôt, une cible de mise en production, une base, un site, un service surveillé, et l’en détacher.',
            type: 'toggle'
        },
        {
            key: 'history',
            label: 'Consulter l’historique',
            description:
                'Lire la frise des faits marquants d’un projet : qui l’a renommé, changé de statut, archivé, quand un jalon est tombé. Les tâches archivées, elles, restent accessibles à qui voit le projet.',
            type: 'toggle'
        },
        {
            key: 'chat',
            label: 'Participer à la discussion',
            description:
                'Écrire et modifier des messages dans le fil du projet. Sans ce droit, le fil se lit seulement.',
            type: 'toggle'
        }
    ],
    /**
     * Le projet lui-même (profil, archivage) dans l'onglet Général de sa fiche, et
     * son histoire dans le dernier : on l'ouvre rarement, pour une question
     * précise, et elle prenait un onglet de la barre toute la journée pour ça.
     * Partage et Permissions viennent du descripteur.
     */
    settings: { item: ['general', { id: 'history', label: 'Historique', icon: 'archive' }] },
    commands: projectCommands
} satisfies FeatureManifest;
