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
     * Ce qu'une conversion coûte au serveur : du temps de calcul, qui croît avec
     * le fichier (`fileBytes`) ; une place dans la file, qui est commune à tous
     * (`activeJobs`) ; et du disque, tant que le résultat attend d'être récupéré
     * (`resultBytes`).
     */
    quotas: [
        { key: 'fileBytes', label: 'par fichier à convertir', unit: 'bytes', perOperation: true },
        { key: 'activeJobs', label: 'conversions en cours à la fois' },
        { key: 'resultBytes', label: 'de résultats en attente de téléchargement', unit: 'bytes' }
    ],
    commands: convertCommands
} satisfies FeatureManifest;
