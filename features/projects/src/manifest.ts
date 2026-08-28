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
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`)
 * reste celui du registre publié, étalé plutôt que recopié : une native garde
 * son identité dans @deveye/types, le manifest n'ajoute que ce que le registre
 * ne porte pas (catégorie, liens, ressources, sujets, capacités, commandes).
 */
const descriptor = featureDescriptor('projects');

export const manifest = {
    ...descriptor,
    /**
     * Déclaré PAR-DESSUS le descripteur, qui dit `'perItem'`.
     *
     * Le descripteur dit ce que le chiffrement AUTORISE : un projet `open`
     * vit à l'étage ouvert, le serveur saurait donc le servir dans un autre
     * espace. Mais le listage n'est pas branché sur le partage
     * (`Docs/SHARING.md` §9 : pas de `listVisible`, pas de codec par ligne),
     * et un module qui déclare autre chose que `'never'` s'engage à l'être
     * (entrée `items` côté serveur, `ctx.sharing.scope()` dans ses listages) :
     * le boot le refuse sinon. Même décision que les Notes et Mail : le
     * registre publié garde sa promesse, le manifest dit l'état du code.
     * Brancher Projets, c'est retirer cette ligne et tenir l'engagement.
     */
    shareTier: 'never',
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
