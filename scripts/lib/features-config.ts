/**
 * Les deux configs de modules et ce qu'on en tire, au même endroit pour les
 * trois scripts qui les lisent (gen-features, smoke-all, uninstall-feature) :
 *
 *  - `features.config.json` (committée) : les modules publics, résolus dans
 *    node_modules ;
 *  - `features.local.json` (gitignorée, optionnelle) : les modules privés de
 *    cette installation, résolus par `path` (dossier relatif à la racine).
 *
 * Une entrée = `{ package, path? }`. D'une entrée on tire le dossier du module
 * (son deveye-feature.json, ses migrations, son uninstall.sql), son manifest
 * (l'entrée racine du paquet, ou le `src/index.ts` d'un module privé, que tsx
 * transpile) et, de l'id du manifest, le préfixe de ses tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { FeatureManifest } from '@deveye/types/sdk';

export interface FeatureConfigEntry {
    package: string;
    /** Module privé : dossier relatif à la racine de l'app, hors node_modules. */
    path?: string;
}

export type FeatureConfigFile = 'features.config.json' | 'features.local.json';

/** Les entrées d'une config, dans l'ordre ; aucune sans le fichier (l'overlay local est optionnel). */
export function readFeatureConfig(root: string, file: FeatureConfigFile): FeatureConfigEntry[] {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) return [];
    return (JSON.parse(fs.readFileSync(full, 'utf8')) as { features?: FeatureConfigEntry[] }).features ?? [];
}

/**
 * Le dossier d'un module : son `path` résolu depuis la racine, sinon le paquet
 * dans node_modules (celui que l'app verrait). Rend null quand le paquet est
 * introuvable, chaque script ayant son message pour ce cas.
 */
export function resolveModuleDir(root: string, entry: FeatureConfigEntry): string | null {
    if (entry.path) return path.resolve(root, entry.path);
    try {
        const require = createRequire(path.join(root, 'package.json'));
        return path.dirname(require.resolve(`${entry.package}/package.json`));
    } catch {
        return null;
    }
}

/**
 * Le manifest exporté par l'entrée racine du module (undefined si elle ne
 * l'exporte pas) : le paquet par son nom, un module privé par son
 * `src/index.ts`.
 */
export async function importManifest(root: string, entry: FeatureConfigEntry): Promise<FeatureManifest | undefined> {
    const specifier = entry.path
        ? pathToFileURL(path.join(path.resolve(root, entry.path), 'src', 'index.ts')).href
        : entry.package;
    const { manifest } = (await import(specifier)) as { manifest?: FeatureManifest };
    return manifest;
}

/**
 * Le préfixe des tables d'un module : `ft_<slug>_`, slug = l'id sans son
 * « x- ». La règle des deux sentinelles SQL (les migrations à la génération,
 * le `uninstall.sql` à la désinstallation).
 */
export function tablePrefix(featureId: string): string {
    return `ft_${featureId.replace(/^x-/, '')}_`;
}
