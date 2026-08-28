import { featureDescriptor } from '@deveye/types';

import { gitCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Git, au format manifest : la onzième native rapatriée sur le SDK, à
 * éléments partagés (projections inter-espaces, restrictions par dépôt), avec
 * un service de fond (la synchronisation des dépôts chez GitHub, par tranches
 * et sous quota), et dont l'onglet d'un projet compose les composants par un
 * provider client.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `sources`, `shareTier: 'open'`) reste celui du registre publié, étalé
 * plutôt que recopié : une native garde son identité dans @deveye/types, le
 * manifest n'ajoute que ce que le registre ne porte pas (catégorie,
 * ressources, onglets de réglages, commandes).
 *
 * `shareTier: 'open'` est un engagement, tenu : l'entrée `items` du serveur
 * (domicile et intitulé d'un dépôt), `ctx.sharing.scope()` dans les listages
 * (le codec choisi ligne par ligne) et `ctx.items.restrictions()` sur ce
 * qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('git');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Trois clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil (`git.count`), la liste (`git.list`) et la fiche d'un
     * dépôt (`git.repo`, que l'onglet d'un projet suit aussi). Le sujet `git`
     * les ravive toutes : après une écriture d'un membre, et à chaque tour de
     * synchronisation qui a changé quelque chose (jamais sur un tour de 304).
     */
    resources: ['git.count', 'git.list', 'git.repo'],
    /**
     * Une seule native appelée, les membres de l'espace : le rattachement
     * d'un auteur git à une personne (`git.authorMap`) vérifie qu'elle est
     * membre, et le graphe (`git.commitGraph`) colore un auteur rattaché de
     * la couleur de son compte, que la façade rend avec chaque membre. Git ne
     * prévient personne (`notifies: false`), et ce qu'il dit à Projets (la
     * version d'un projet qui suit une release) passe par le contrat que
     * Projets lui offre, pas par une capacité.
     */
    nativeCapabilities: ['members.read'],
    /**
     * Les jetons GitHub (les sources de la feature) se gèrent à l'échelle de
     * la fonctionnalité, dans l'onglet Sources ; le dialogue d'un dépôt n'en
     * fait que choisir un, et son « + » ouvre cet onglet. Partage et
     * Permissions viennent du descripteur.
     */
    settings: { feature: ['sources'] },
    commands: gitCommands
} satisfies FeatureManifest;
