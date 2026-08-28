import type { FeatureDefinition } from '../_define';
import {
    devicesCancelDeleteFeature,
    devicesConfirmFeature,
    devicesDeleteFeature,
    devicesForceDeleteFeature,
    devicesListFeature,
    devicesReactivateFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesRequestDeleteFeature,
    devicesRevokeFeature,
    devicesSetConfigFeature,
    devicesSetWorkspacesFeature,
    devicesWorkspaceListFeature
} from './lifecycle';

/**
 * La feature Appareils (pages Appareils et Monitoring), part cycle de vie :
 * appairage et statut (liste, approbation, révocation, renommage, suppression),
 * configuration de collecte et partage entre espaces (workspaceList,
 * setWorkspaces). L'historique lu en base est dans `../metrics`, sous le même
 * préfixe `devices.*` ; tout ce qui relaie un ordre à l'agent est du transport,
 * dans `../agent` (`agent.*`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deviceFeatures: FeatureDefinition<string, any, any>[] = [
    devicesListFeature,
    devicesConfirmFeature,
    devicesRevokeFeature,
    devicesReactivateFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesSetConfigFeature,
    devicesWorkspaceListFeature,
    devicesSetWorkspacesFeature,
    devicesRequestDeleteFeature,
    devicesCancelDeleteFeature,
    devicesForceDeleteFeature,
    devicesDeleteFeature
];
