import { isExternalFeatureId, registerExternalFeature, registerFeatureCommands } from '@deveye/types';
import { externalDescriptorOf, validateManifest, type FeatureManifest } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import { registerCrossTopicKeys, registerFeatureResources, type ResourceKey } from '@/stores/invalidation';

/**
 * Le registre des modules installés, côté client.
 *
 * Volontairement **sans dépendance vers le fichier généré** : ce module est
 * une feuille, que le catalogue, la coquille de réglages, RoleDialog et
 * goToHome peuvent importer depuis n'importe où. C'est l'initialiseur
 * (`sdk/modules.ts`), et lui seul, qui importe la glue générée et verse les
 * modules ici. Sans cette coupure, le graphe bouclait : le client d'un module
 * importe `deveye-sdk-client`, dont le barrel tire la coquille de réglages,
 * qui a besoin du registre... qui aurait importé le généré en train d'évaluer
 * ce même module (« Cannot access 'client0' before initialization », écran
 * blanc).
 */
export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}

const MODULES: InstalledClientFeature[] = [];
const BY_ID = new Map<string, InstalledClientFeature>();

/**
 * Verse les modules installés dans le registre : descripteur (registre fusionné
 * de @deveye/types, dont vivent RoleDialog, la coquille et la présence) et
 * ressources d'invalidation. Appelée une fois, par l'initialiseur, avant tout
 * rendu.
 */
export function registerClientModules(installed: readonly InstalledClientFeature[]): void {
    for (const mod of installed) {
        // Même règle que le serveur (`registerModules`) : un id en double est
        // une erreur de config, pas un doublon à ignorer.
        if (BY_ID.has(mod.manifest.id)) throw new Error(`Module « ${mod.manifest.id} » : déclaré deux fois`);
        validateManifest(mod.manifest);
        // Une native rapatriée (Météo) garde son descripteur dans le registre
        // publié : seuls les ids externes s'enregistrent ici.
        if (isExternalFeatureId(mod.manifest.id)) registerExternalFeature(externalDescriptorOf(mod.manifest));
        // Les contrats du module dans le registre des commandes : c'est lui
        // que `ws.send` consulte avant d'envoyer. Une native rapatriée y
        // redéclare les mêmes objets (no-op) ; un module externe n'existe que
        // par cet enregistrement : sans lui, chaque commande serait refusée
        // localement (« Unknown command ») et l'UI resterait en chargement.
        registerFeatureCommands(mod.manifest.commands);
        registerFeatureResources(
            mod.manifest.id,
            (mod.manifest.invalidatedByTopic ?? mod.manifest.resources) as ResourceKey[]
        );
        for (const cross of mod.manifest.alsoInvalidatedBy ?? []) {
            registerCrossTopicKeys(cross.topic, cross.keys as ResourceKey[]);
        }
        MODULES.push(mod);
        BY_ID.set(mod.manifest.id, mod);
    }
}

/** Les modules installés, dans l'ordre de la config. */
export function clientModules(): readonly InstalledClientFeature[] {
    return MODULES;
}

/** Le manifest d'un module installé, ou `undefined` (id natif ou module retiré). */
export function moduleManifest(featureId: string): FeatureManifest | undefined {
    return BY_ID.get(featureId)?.manifest;
}

/** L'entrée client d'un module installé. */
export function moduleClient(featureId: string): FeatureClient | undefined {
    return BY_ID.get(featureId)?.client;
}

/**
 * Le contrat nommé qu'un module offre aux écrans de l'app (voir
 * `@deveye/types/sdk/providers`), le jumeau client de `moduleProvider` :
 * recherche au rendu, `undefined` quand le module est absent, et c'est à
 * l'écran de dégrader proprement.
 */
export function moduleClientProvider<T>(key: string): T | undefined {
    for (const mod of MODULES) {
        const value = mod.client.providers?.[key];
        if (value !== undefined) return value as T;
    }
    return undefined;
}

/**
 * Un module dont les éléments se projettent (`shareTier` autre que 'never') :
 * l'équivalent, pour un module, d'une entrée dans `SHARE_WIRED_FEATURES`. Le
 * serveur exige l'entrée `items` au boot, donc le manifest suffit ici.
 */
export function isModuleShareWired(featureId: string): boolean {
    const manifest = BY_ID.get(featureId)?.manifest;
    return manifest !== undefined && manifest.shareTier !== 'never';
}
