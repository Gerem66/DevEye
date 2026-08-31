import { featureDescriptor } from '@deveye/types';

import { cveCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('cve');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Le fil, les épingles, et l'état de la clé de l'espace. Le détail d'une CVE
     * (`cve.get`) et les résultats de recherche se relisent à la demande.
     */
    resources: ['cve.news', 'cve.favorites', 'cve.keyList'],
    /**
     * Le fil a son propre sujet : l'ingestion tourne toute seule et ne doit pas
     * faire recharger les épingles de tout le monde à chaque tour.
     */
    topics: [{ id: 'cveFeed', keys: ['cve.news'] }],
    /** Symétriquement, ce qu'un membre écrit ne recharge jamais le fil. */
    invalidatedByTopic: ['cve.favorites', 'cve.keyList'],
    settings: { feature: ['sources'] },
    /**
     * Poser la clé du NVD se confie séparément de l'écriture : épingler une CVE
     * ne doit pas donner la main sur un secret d'espace.
     */
    extraPermissions: [
        {
            key: 'manageKeys',
            label: 'Gérer les clés d’API',
            description:
                'Enregistrer et supprimer la clé d’API du NVD de l’espace. Sans ce droit, l’écriture permet toujours d’épingler des CVE.',
            type: 'toggle'
        }
    ],
    commands: cveCommands
} satisfies FeatureManifest;
