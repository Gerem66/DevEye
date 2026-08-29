import { featureDescriptor } from '@deveye/types';

import { sentinelCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif reste celui du registre publié ; le manifest n'ajoute que ce
 * que le registre ne porte pas.
 */
const descriptor = featureDescriptor('sentinel');

export const manifest = {
    ...descriptor,
    category: 'security',
    /** Ravivées ensemble par le sujet `sentinel`, `count` en tête : la clé qui doit bouger le plus vite. */
    resources: ['sentinel.count', 'sentinel.overview', 'sentinel.findings', 'sentinel.baseline'],
    /**
     * Appareils (autoriser, lister, la flotte), télémétrie (l'instant jugé, la
     * preuve épinglée), agents (relevé, config, hooks), canaux d'alerte.
     */
    nativeCapabilities: ['devices.read', 'telemetry.read', 'agents', 'notify'],
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /** Un onglet Appareils à l'échelle de la feature : Sentinelle n'a pas d'éléments, ses « éléments » sont des appareils. */
    settings: { feature: [{ id: 'devices', label: 'Appareils', icon: 'server' }] },
    commands: sentinelCommands
} satisfies FeatureManifest;
