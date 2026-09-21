import { featureDescriptor } from '@deveye/types';

import { convertCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('convert');

export const manifest = {
    ...descriptor,
    category: 'daily',
    resources: ['convert.list', 'convert.capabilities', 'convert.rates', 'convert.settings'],
    /**
     * Les taux ont leur propre sujet : le service les rafraîchit seul, et un
     * travail qui avance ne doit pas les faire relire à tout l'espace.
     */
    topics: [{ id: 'convertRates', keys: ['convert.rates'] }],
    invalidatedByTopic: ['convert.list', 'convert.capabilities', 'convert.settings'],
    settings: { feature: ['general', 'notifications'] },
    nativeCapabilities: ['notify', 'routes.public', 'live.publish'],
    /**
     * La taille d'UN fichier, pas un cumul : ce qui coûte au serveur est le
     * temps de calcul d'une conversion, et il croît avec le fichier.
     */
    quotas: [{ key: 'fileBytes', label: 'par fichier à convertir', unit: 'bytes' }],
    commands: convertCommands
} satisfies FeatureManifest;
