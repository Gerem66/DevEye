import type { SdkQueryable } from '@deveye/types/sdk/server';

import { deviceRepo, type DeviceRepo } from './devices';
import { linkCodeRepo, type LinkCodeRepo } from './linkCodes';
import { metricRepo, type MetricRepo } from './metrics';
import { presenceRepo, type PresenceRepo } from './presence';
import { processSampleRepo, type ProcessSampleRepo } from './processSamples';

export type { DeviceConfigPatch, DeviceRepo } from './devices';
export type { LinkCode, LinkCodeRepo } from './linkCodes';
export type { MetricRepo } from './metrics';
export type { PresenceRepo } from './presence';
export type { ProcessSampleRepo, SnapshotStorage } from './processSamples';

/**
 * Le dépôt du module, sur les tables du socle.
 *
 * Deux lecteurs, un schéma, et c'est assumé : les six tables allowlistées
 * (`devices`, `device_workspaces`, `device_link_codes`, `device_metrics`,
 * `device_process_samples`, `device_presence`) sont écrites HORS session par
 * l'infrastructure de l'app (l'enrôlement, l'ingestion de la télémétrie, la
 * présence : `src/agent/**`, par les dépôts du socle
 * `src/db/repos/{devices,metrics,processSamples,presence}.ts`), qui garde ses
 * requêtes pour ce qu'elle y écrit. Le module tient ici les siennes, un
 * fichier par table comme le socle : la FLOTTE (statut, nom, configuration de
 * collecte, espaces, codes de liaison) et l'HISTORIQUE (fenêtres de
 * métriques, présence, processus, épinglage, purges). Une colonne, une
 * contrainte, un index se changent par une migration du socle : le module
 * n'en possède aucune, et n'en écrira (`ft_devices_`) que pour une table à lui.
 *
 * Les dépôts ne déchiffrent rien : aucune de ces tables n'est chiffrée.
 */
export interface DevicesRepo {
    devices: DeviceRepo;
    linkCodes: LinkCodeRepo;
    metrics: MetricRepo;
    presence: PresenceRepo;
    processSamples: ProcessSampleRepo;
}

export function createRepo(q: SdkQueryable): DevicesRepo {
    return {
        devices: deviceRepo(q),
        linkCodes: linkCodeRepo(q),
        metrics: metricRepo(q),
        presence: presenceRepo(q),
        processSamples: processSampleRepo(q)
    };
}
