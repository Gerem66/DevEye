import { featureDescriptor } from '@deveye/types';

import { deployCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Déploiements, au format manifest. Le descriptif (intitulé, icône, rôles,
 * `notifies`, `hasItems`, `itemNoun`, `sources`, `shareTier`) vient du registre
 * publié ; le manifest n'ajoute que ce que le registre ne porte pas.
 *
 * `shareTier: 'open'` engage : l'entrée `items` du serveur, `ctx.sharing.scope()`
 * dans les listages et `ctx.items.restrictions()` sur ce qu'ils rendent. Le boot
 * refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('deploy');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Le compte de la carte d'accueil, la liste, la fiche d'une cible (que
     * l'onglet d'un projet suit aussi). Le sujet `deploy` les ravive après une
     * écriture et à chaque changement d'état vu par le rapprochement de fond.
     */
    resources: ['deploy.count', 'deploy.list', 'deploy.detail'],
    /** Les canaux d'avis par cible, message vivant compris (`notify.liveChannels`, `notify.postLive`). */
    nativeCapabilities: ['notify'],
    /** Ce que la fiche « À propos » relie : les avis partent par un compte Mail. */
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * Les accès Dokploy se gèrent dans l'onglet Sources ; le dialogue d'une
     * cible n'en fait que choisir un. Notifications, Partage et Permissions
     * viennent du descripteur.
     */
    settings: { feature: ['sources'] },
    commands: deployCommands
} satisfies FeatureManifest;
