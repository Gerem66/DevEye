import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { pdfCommands } from './contracts/commands';

/**
 * Aucun quota : l'atelier travaille dans le navigateur, le serveur ne garde
 * que les signatures du compte, six au plus. Ce qui demande un outil (alléger,
 * reconnaître le texte) est confié au Convertisseur, qui a les siens.
 */
const descriptor = featureDescriptor('pdf');

export const manifest = {
    ...descriptor,
    category: 'daily',
    resources: ['pdf.signatures'],
    commands: pdfCommands
} satisfies FeatureManifest;
