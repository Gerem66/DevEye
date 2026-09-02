import { featureDescriptor } from '@deveye/types';

import { gitCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descripteur du registre porte l'identité de la feature ; le manifest
 * n'ajoute que ce qu'il ne porte pas. Son `shareTier: 'open'` engage l'entrée
 * `items` du serveur, `ctx.sharing.scope()` et `ctx.items.restrictions()`.
 */
const descriptor = featureDescriptor('git');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Le sujet `git` les ravive toutes : après une écriture, et à chaque tour de
     * synchronisation qui a changé quelque chose (jamais sur un tour de 304).
     */
    resources: ['git.count', 'git.list', 'git.repo'],
    /**
     * Les membres de l'espace : `git.authorMap` vérifie l'appartenance, et
     * `git.commitGraph` colore un auteur rattaché de la couleur de son compte.
     */
    nativeCapabilities: ['members.read'],
    /**
     * Les jetons GitHub dans l'onglet Sources de la feature ; le dépôt lui-même
     * (jeton, synchronisation, suppression) dans l'onglet Général de sa fiche.
     * Partage et Permissions viennent du descripteur.
     */
    settings: { feature: ['sources'], item: ['general'] },
    commands: gitCommands
} satisfies FeatureManifest;
