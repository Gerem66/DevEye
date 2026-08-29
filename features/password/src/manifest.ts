import { featureDescriptor } from '@deveye/types';

import { passwordCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif (intitulé, icône, `shareTier: 'never'`) vient du registre
 * publié ; le manifest n'ajoute que ce que le registre ne porte pas. Pas
 * d'onglet de réglages : le coffre n'a rien à régler.
 */
const descriptor = featureDescriptor('password');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Le compte de la carte d'accueil (métadonnées claires, jamais verrouillé) et
     * la liste masquée de l'écran, ravivés par le sujet `password`.
     */
    resources: ['password.count', 'password.list'],
    commands: passwordCommands
} satisfies FeatureManifest;
