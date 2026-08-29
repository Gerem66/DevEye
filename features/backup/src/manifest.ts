import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { backupCommands } from './contracts/commands';

/**
 * L'id `backup` et son descripteur restent dans le registre publié : droits,
 * grants et routes de notification persistés les référencent.
 */
const descriptor = featureDescriptor('backup');

export const manifest = {
    ...descriptor,
    category: 'dev',
    resources: ['backup.count', 'backup.destinationList', 'backup.jobList', 'backup.detail', 'backup.runs'],
    /** Les destinations se gèrent à l'échelle de la feature, la forme des archives par travail. */
    settings: { feature: ['sources'], item: ['encryption'] },
    /**
     * `agents` pour écrire par l'agent d'une machine (`DeviceSink`),
     * `devices.read` pour n'accepter comme destination qu'une machine de l'espace.
     */
    nativeCapabilities: ['agents', 'devices.read'],
    links: [
        { to: 'database', what: 'sauvegarde les bases supervisées' },
        { to: 'cloudsync', what: 'archive les fichiers d’un partage' },
        { to: 'mail', what: 'envoie ses alertes par un compte Mail' }
    ],
    commands: backupCommands
} satisfies FeatureManifest;
