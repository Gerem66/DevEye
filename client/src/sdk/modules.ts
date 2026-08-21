import { isExternalFeatureId, registerExternalFeature, type ExternalFeatureId } from 'deveye-types';
import { validateManifest, type FeatureManifest } from 'deveye-types/sdk';
import type { FeatureClient } from 'deveye-types/sdk/client';

import { INSTALLED_CLIENT_FEATURES, type InstalledClientFeature } from '@/generated/features';
import { registerFeatureResources, type ResourceKey } from '@/stores/invalidation';

/**
 * Le pendant client de `src/features/_sdk/register.ts` du serveur : au
 * chargement, chaque module installé déclare son descripteur (registre fusionné
 * de deveye-types, dont vivent RoleDialog, la coquille de réglages et la
 * présence) et ses ressources d'invalidation. Importé par App.tsx avant tout
 * rendu ; la liste vient du fichier GÉNÉRÉ, figée à la compilation.
 */
const BY_ID = new Map<string, InstalledClientFeature>();

for (const mod of INSTALLED_CLIENT_FEATURES) {
    validateManifest(mod.manifest);
    // Une native rapatriée (Météo) garde son descripteur dans le registre
    // publié : seuls les ids externes s'enregistrent ici.
    if (isExternalFeatureId(mod.manifest.id)) {
        registerExternalFeature({
            id: mod.manifest.id as ExternalFeatureId,
            label: mod.manifest.label,
            description: mod.manifest.description,
            icon: mod.manifest.icon,
            notifies: mod.manifest.notifies,
            hasItems: mod.manifest.hasItems,
            itemNoun: mod.manifest.itemNoun,
            sources: mod.manifest.sources,
            shareTier: mod.manifest.shareTier
        });
    }
    registerFeatureResources(
        mod.manifest.id,
        (mod.manifest.invalidatedByTopic ?? mod.manifest.resources) as ResourceKey[]
    );
    BY_ID.set(mod.manifest.id, mod);
}

/** Les modules installés, dans l'ordre de la config. */
export function clientModules(): readonly InstalledClientFeature[] {
    return INSTALLED_CLIENT_FEATURES;
}

/** Le manifest d'un module installé, ou `undefined` (id natif ou module retiré). */
export function moduleManifest(featureId: string): FeatureManifest | undefined {
    return BY_ID.get(featureId)?.manifest;
}

/** L'entrée client d'un module installé. */
export function moduleClient(featureId: string): FeatureClient | undefined {
    return BY_ID.get(featureId)?.client;
}
