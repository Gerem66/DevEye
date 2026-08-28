import { featureDescriptor } from '@deveye/types';

import { audienceCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Audience, au format manifest : la douzième native rapatriée sur le SDK, à
 * éléments partagés (projections inter-espaces, restrictions par site), avec
 * un service de fond (l'ingestion des visites : file en mémoire, vidange par
 * lots, agrégat journalier, rétention), et la première à ouvrir des routes
 * HTTP PUBLIQUES (le script de mesure et les deux points d'entrée des
 * balises), ce que la capacité `routes.public` déclare.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier: 'open'`) reste celui du registre publié, étalé plutôt que
 * recopié : une native garde son identité dans @deveye/types, le manifest
 * n'ajoute que ce que le registre ne porte pas (catégorie, ressources,
 * capacités, onglets de réglages, commandes).
 *
 * `shareTier: 'open'` est un engagement, tenu : l'entrée `items` du serveur
 * (domicile et intitulé d'un site), `ctx.sharing.scope()` dans les listages
 * (le codec choisi ligne par ligne) et `ctx.items.restrictions()` sur ce
 * qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('audience');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Quatre clés de cache, telles que les écrans les invalident : le compte
     * de la carte d'accueil (`audience.count`), la liste (`audience.list`), la
     * fiche d'un site (`audience.detail`, que l'onglet d'un projet suit aussi)
     * et les statistiques (`audience.stats`, ravivée à part par le battement
     * de l'ingestion, une fois par minute et par espace au plus). Le sujet
     * `audience` les ravive toutes.
     */
    resources: ['audience.count', 'audience.list', 'audience.detail', 'audience.stats'],
    /**
     * La seule native appelée : les routes publiques. L'ingestion est appelée
     * par des navigateurs qui ne savent rien de DevEye, depuis des sites qui
     * ne lui appartiennent pas, sans personne derrière ; le module les déclare
     * (`publicRoutes`), l'hôte les monte sur chacun de ses écouteurs exposés.
     */
    nativeCapabilities: ['routes.public'],
    /**
     * Un panneau Général à l'échelle d'un SITE : la rétention des événements
     * bruts, la reconnaissance des visiteurs et l'état de la mesure, qui
     * vivaient dans le dialogue d'édition (dette de la coquille, réglée au
     * rapatriement). Le dialogue ne garde que l'identité du site (nom,
     * description, plateforme, origines autorisées) ; sa clé publique et son
     * installation ont leur propre dialogue. Partage et Permissions viennent
     * du descripteur.
     */
    settings: { item: ['general'] },
    commands: audienceCommands
} satisfies FeatureManifest;
