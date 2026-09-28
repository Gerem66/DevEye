import { isExternalFeatureId, registerExternalFeature, registerFeatureCommands } from '@deveye/types';
import { externalDescriptorOf, validateManifest, type FeatureManifest } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import { registerCrossTopicKeys, registerFeatureResources, type ResourceKey } from '@/stores/invalidation';
import { isFeatureHidden } from '@/stores/maintenance';

/**
 * Le registre des modules installés, côté client. Volontairement sans dépendance
 * vers le fichier généré : ce module est une feuille, importable de partout, et
 * l'initialiseur (`sdk/modules.ts`) est seul à importer la glue générée pour y
 * verser les modules. Sans cette coupure le graphe boucle, le client d'un module
 * important `deveye-sdk-client`, dont le barrel tire la coquille de réglages, qui
 * a besoin du registre.
 */
export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}

const MODULES: InstalledClientFeature[] = [];
const BY_ID = new Map<string, InstalledClientFeature>();

/**
 * Verse les modules installés dans le registre : descripteur et ressources
 * d'invalidation. Appelée une fois, par l'initialiseur, avant tout rendu.
 */
export function registerClientModules(installed: readonly InstalledClientFeature[]): void {
    for (const mod of installed) {
        // Même règle que le serveur : un id en double est une erreur de config, pas
        // un doublon à ignorer.
        if (BY_ID.has(mod.manifest.id)) throw new Error(`Module « ${mod.manifest.id} » : déclaré deux fois`);
        validateManifest(mod.manifest);
        if (!mod.manifest.accountOnly && (!mod.client.Widget || !mod.client.Full)) {
            throw new Error(`Module « ${mod.manifest.id} » : Widget et Full sont requis`);
        }
        // Un module à id natif a déjà son descripteur dans le registre publié :
        // seuls les ids externes s'enregistrent ici. Un module de compte n'a ni
        // carte ni ligne dans l'écran des rôles : pas de descripteur.
        if (isExternalFeatureId(mod.manifest.id) && !mod.manifest.accountOnly) {
            registerExternalFeature(externalDescriptorOf(mod.manifest));
        }
        // Les contrats du module dans le registre que `ws.send` consulte avant
        // d'envoyer. Un module externe n'existe que par cet enregistrement : sans
        // lui, chaque commande serait refusée localement (« Unknown command »).
        registerFeatureCommands(mod.manifest.commands);
        registerFeatureResources(
            mod.manifest.id,
            (mod.manifest.invalidatedByTopic ?? mod.manifest.resources) as ResourceKey[]
        );
        for (const cross of mod.manifest.alsoInvalidatedBy ?? []) {
            registerCrossTopicKeys(cross.topic, cross.keys as ResourceKey[]);
        }
        // Les sujets secondaires du module : chacun ravive les clés qu'il nomme,
        // comme le sujet principal ravive `resources`.
        for (const topic of mod.manifest.topics ?? []) {
            registerFeatureResources(topic.id, topic.keys as ResourceKey[]);
        }
        MODULES.push(mod);
        BY_ID.set(mod.manifest.id, mod);
    }
}

/** Les modules installés, dans l'ordre de la config. */
export function clientModules(): readonly InstalledClientFeature[] {
    return MODULES;
}

/** Les modules qui ont une carte : tous, sauf ceux qui ne vivent que dans le menu du compte. */
export function cardModules(): readonly InstalledClientFeature[] {
    return MODULES.filter((m) => !m.manifest.accountOnly);
}

/** Les pages système que les modules ajoutent au menu, pour les administrateurs. */
export function adminEntries(): readonly InstalledClientFeature[] {
    return MODULES.filter((m) => m.manifest.adminEntry && m.client.AdminView);
}

/** Les entrées que les modules ajoutent au menu du compte, sous « Sécurité ». */
export function accountEntries(): readonly InstalledClientFeature[] {
    return MODULES.filter((m) => m.manifest.accountEntry && m.client.AccountView);
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
 * `@deveye/types/sdk/providers`), jumeau client de `moduleProvider` : recherche
 * au rendu, `undefined` quand le module est absent ou en préversion pour ce
 * compte, à l'écran de dégrader.
 */
export function moduleClientProvider<T>(key: string): T | undefined {
    for (const mod of MODULES) {
        if (isFeatureHidden(mod.manifest.id)) continue;
        const value = mod.client.providers?.[key];
        if (value !== undefined) return value as T;
    }
    return undefined;
}

/**
 * Un module dont les éléments se projettent (`shareTier` autre que 'never'),
 * l'équivalent d'une entrée dans `SHARE_WIRED_FEATURES`. Le serveur exige
 * l'entrée `items` au boot, donc le manifest suffit ici.
 */
export function isModuleShareWired(featureId: string): boolean {
    const manifest = BY_ID.get(featureId)?.manifest;
    return manifest !== undefined && manifest.shareTier !== 'never';
}
