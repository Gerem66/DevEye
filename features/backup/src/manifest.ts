import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { backupCommands } from './contracts/commands';

/**
 * Sauvegardes, au format manifest. Native rapatriée : l'id `backup` et son
 * descripteur restent dans le registre publié (les droits, les grants et les
 * routes de notification persistés les référencent), tout le reste vit ici.
 */
const descriptor = featureDescriptor('backup');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Les clés de cache de la feature, telles que les écrans les invalident :
     * la tuile (`count`), les deux listes, la fiche d'un travail (`detail`) et
     * la vue d'ensemble des exécutions (`runs`).
     */
    resources: ['backup.count', 'backup.destinationList', 'backup.jobList', 'backup.detail', 'backup.runs'],
    /**
     * Les destinations (les sources de la feature) se gèrent à l'échelle de
     * la fonctionnalité ; la forme des archives se choisit par TRAVAIL, dans
     * l'onglet Chiffrement de ses réglages. Notifications, partage et
     * permissions viennent du descripteur (`notifies`, `shareTier`).
     */
    settings: { feature: ['sources'], item: ['encryption'] },
    /**
     * La flotte d'agents pour écrire une archive sur une machine par son
     * agent (`DeviceSink`), et la lecture des appareils de l'espace pour
     * n'accepter comme destination qu'une machine qui lui appartient.
     */
    nativeCapabilities: ['agents', 'devices.read'],
    links: [
        { to: 'database', what: 'sauvegarde les bases supervisées' },
        { to: 'cloudsync', what: 'archive les fichiers d’un partage' },
        { to: 'mail', what: 'envoie ses alertes par un compte Mail' }
    ],
    commands: backupCommands
} satisfies FeatureManifest;
