import { featureDescriptor } from '@deveye/types';

import { audienceCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Audience au format manifest : éléments partagés (projections inter-espaces,
 * restrictions par site), un service de fond (l'ingestion des visites) et des
 * routes HTTP publiques, ce que la capacité `routes.public` déclare.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier`) vient du registre publié ; le manifest n'ajoute que ce que le
 * registre ne porte pas.
 *
 * `shareTier: 'open'` est un engagement : l'entrée `items` du serveur,
 * `ctx.sharing.scope()` dans les listages et `ctx.items.restrictions()` sur ce
 * qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('audience');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Quatre clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil, la liste, la fiche d'un site (que l'onglet d'un projet
     * suit aussi) et les statistiques, ravivées à part par le battement de
     * l'ingestion. Le sujet `audience` les ravive toutes.
     */
    resources: ['audience.count', 'audience.list', 'audience.detail', 'audience.stats'],
    /**
     * L'ingestion est appelée par des navigateurs qui ne savent rien de DevEye,
     * depuis des sites qui ne lui appartiennent pas : le module déclare ces
     * routes, l'hôte les monte sur chacun de ses écouteurs exposés.
     */
    nativeCapabilities: ['routes.public'],
    /**
     * Un panneau Général à l'échelle d'un site : rétention des événements bruts,
     * reconnaissance des visiteurs, état de la mesure. Le dialogue ne garde que
     * l'identité du site ; sa clé publique et son installation ont le leur.
     * Partage et Permissions viennent du descripteur.
     */
    settings: { item: ['general'] },
    commands: audienceCommands
} satisfies FeatureManifest;
