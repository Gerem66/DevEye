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
 * Le dépôt du module, sur les tables du socle. Les six tables allowlistées
 * (`devices`, `device_workspaces`, `device_link_codes`, `device_metrics`,
 * `device_process_samples`, `device_presence`) sont aussi écrites hors session
 * par l'infrastructure de l'app (`src/agent/**`), qui garde ses propres
 * requêtes. Une colonne, une contrainte, un index se changent par une migration
 * du socle. Rien n'est chiffré.
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
