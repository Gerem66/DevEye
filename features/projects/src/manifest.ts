import { featureDescriptor } from '@deveye/types';

import { projectCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Projets, au format manifest : la quatorzième native rapatriée sur le SDK,
 * et la première à battre DEUX sujets. Un fil de discussion change à une tout
 * autre cadence que la structure qui le porte : sans `projectsChat`, chaque
 * message ferait re-solliciter le tableau, la frise et le portefeuille
 * entiers. C'est le premier usage de `manifest.topics`, dont le sujet
 * secondaire fut longtemps un privilège natif.
 *
 * Le préfixe des commandes et des ressources est l'id de la feature
 * (`projects.*`) : l'ancien `project.*` ne tenait qu'à l'usage natif, un
 * module parle sous son id.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier`) reste celui du registre publié, étalé plutôt que recopié : une
 * native garde son identité dans @deveye/types, le manifest n'ajoute que ce
 * que le registre ne porte pas (catégorie, liens, ressources, sujets,
 * capacités, commandes).
 *
 * `shareTier: 'perItem'` vient donc du descripteur, et le module tient
 * l'engagement qu'il emporte : l'entrée `items` de `server/index.ts` (un
 * projet ouvert se projette, un projet gardé jamais), `ctx.sharing.scope()`
 * dans ses listages, le codec choisi projet par projet (`Docs/SHARING.md`,
 * `Docs/PROJECTS.md` §4 « Le partage »).
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
     * Cinq clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil, le portefeuille, le détail ouvert (tableau, frise,
     * liaisons, historique : une seule clé, ils se relisent ensemble), mes
     * tâches à travers les projets, et les messages du projet ouvert. Le sujet
     * `projects` ravive les quatre premières ; `projectsChat` les messages et
     * le portefeuille (ses compteurs de non-lus).
     */
    resources: ['projects.count', 'projects.list', 'projects.board', 'projects.myTasks', 'projects.messages'],
    invalidatedByTopic: ['projects.count', 'projects.list', 'projects.board', 'projects.myTasks'],
    topics: [{ id: 'projectsChat', keys: ['projects.messages', 'projects.list'] }],
    /** Les assignés d'une carte et les auteurs d'un message sont des membres. */
    nativeCapabilities: ['members.read'],
    commands: projectCommands
} satisfies FeatureManifest;
