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
     * Le projet lui-même (profil, archivage) dans l'onglet Général de sa fiche.
     * Partage et Permissions viennent du descripteur.
     */
    settings: { item: ['general'] },
    commands: projectCommands
} satisfies FeatureManifest;
