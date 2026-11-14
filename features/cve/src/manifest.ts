import { featureDescriptor } from '@deveye/types';

import { cveCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('cve');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Le fil, les épingles, l'état de la clé de l'espace, et l'exposition de
     * l'espace. Le détail d'une CVE (`cve.get`), d'un élément (`cve.asset`) et
     * les résultats de recherche se relisent à la demande.
     */
    resources: [
        'cve.news',
        'cve.favorites',
        'cve.keyList',
        'cve.exposurePrefs',
        'cve.exposure',
        'cve.exposureCount',
        'cve.inventory'
    ],
    /**
     * Le fil et l'exposition ont chacun leur sujet : l'ingestion et la veille
     * tournent toutes seules, et ne doivent pas faire recharger les épingles de
     * tout le monde à chaque tour.
     */
    topics: [
        { id: 'cveFeed', keys: ['cve.news'] },
        { id: 'cveExposure', keys: ['cve.exposure', 'cve.exposureCount', 'cve.inventory'] }
    ],
    /** Symétriquement, ce qu'un membre écrit ne recharge jamais le fil. */
    invalidatedByTopic: ['cve.favorites', 'cve.keyList', 'cve.exposurePrefs'],
    settings: { feature: [{ id: 'detection', label: 'Détection', icon: 'search' }, 'sources'] },
    /**
     * Les alertes partent par les canaux de l'espace ; les appareils et leurs
     * conteneurs se lisent par l'agent.
     */
    nativeCapabilities: ['notify', 'devices.read', 'agents'],
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
