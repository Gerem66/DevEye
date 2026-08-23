/**
 * Génère la glue des modules de features.
 *
 * Deux configs, deux jeux de sorties :
 *
 *  - `features.config.json` (COMMITTÉE) : les modules publics. Sorties
 *    committées : `src/features/_generated/installed.ts`,
 *    `client/src/generated/features.ts`, `client/src/Styles/icons.generated.css`
 *    (+ copie des SVG). La CI (`--check`) refuse toute dérive.
 *  - `features.local.json` (GITIGNORÉE) : les modules PRIVÉS de cette
 *    installation, résolus par chemin (`{ "package": ..., "path": "../X" }`).
 *    Sorties gitignorées mais TOUJOURS présentes (stubs vides sans config) :
 *    `installed.local.ts`, `features.local.ts`, `icons.local.css`, importées
 *    statiquement par la glue committée. La CI publique ne voit jamais un
 *    module privé et reste verte sans lui.
 *
 * Modes : défaut = tout ; `--ensure-local` = seulement les trois fichiers
 * locaux (rapide, tourne en prestart et en tête de ci) ; `--check` = vérifie
 * les sorties committées, RÉPARE les locales.
 *
 * Le générateur est aussi la première sentinelle : ids valides et uniques (les
 * deux configs confondues), version minimale de deveye-types, préfixe de table
 * `ft_<slug>_` vérifié par balayage statique des migrations SQL (allowlist
 * `deveye-feature.json` pour les tables historiques d'une native rapatriée).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateManifest, type FeatureManifest } from 'deveye-types/sdk';

import { sqlTableTargets } from './sql-tables';
import { forbiddenUninstallTargets } from './uninstall-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const CHECK = process.argv.includes('--check');
const ENSURE_LOCAL = process.argv.includes('--ensure-local');

const SERVER_GEN = path.join(ROOT, 'src', 'features', '_generated');
const CLIENT_GEN = path.join(ROOT, 'client', 'src', 'generated');
const STYLES_DIR = path.join(ROOT, 'client', 'src', 'Styles');
const ICONS_DIR = path.join(ROOT, 'client', 'public', 'icons');

interface ConfigEntry {
    package: string;
    /** Module privé : dossier relatif à la racine de l'app, hors node_modules. */
    path?: string;
}

interface BuildMeta {
    id: string;
    tables?: string[];
    minTypesVersion?: string;
}

interface ResolvedModule {
    pkg: string;
    dir: string;
    manifest: FeatureManifest;
    /** L'icône finale (préfixée si le module embarque son SVG). */
    icon: string;
    iconSource: string | null;
    /** Résolu par chemin (module privé) : la glue l'importe en relatif. */
    localPath: string | null;
}

function fail(message: string): never {
    console.error(`gen-features: ${message}`);
    process.exit(1);
}

function parseVersion(v: string): number[] {
    return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function versionAtLeast(installed: string, wanted: string): boolean {
    const a = parseVersion(installed);
    const b = parseVersion(wanted);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
}

async function resolveModule(entry: ConfigEntry): Promise<ResolvedModule> {
    let dir: string;
    let localPath: string | null = null;
    if (entry.path) {
        dir = path.resolve(ROOT, entry.path);
        localPath = dir;
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
            fail(`« ${entry.package} » : dossier introuvable ou sans package.json (${entry.path})`);
        }
        const name = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
        if (name !== entry.package) fail(`${entry.path}: le package s'appelle « ${name} », pas « ${entry.package} »`);
    } else {
        try {
            dir = path.dirname(require.resolve(`${entry.package}/package.json`));
        } catch {
            fail(`« ${entry.package} » est dans la config mais introuvable dans node_modules (npm install ?)`);
        }
    }

    const metaPath = path.join(dir, 'deveye-feature.json');
    if (!fs.existsSync(metaPath)) fail(`${entry.package}: deveye-feature.json manquant`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as BuildMeta;

    if (meta.minTypesVersion) {
        const typesVersion = (
            JSON.parse(fs.readFileSync(require.resolve('deveye-types/package.json'), 'utf8')) as { version: string }
        ).version;
        if (!versionAtLeast(typesVersion, meta.minTypesVersion)) {
            fail(`${entry.package}: exige deveye-types >= ${meta.minTypesVersion}, installé ${typesVersion}`);
        }
    }

    const entryFile = entry.path ? pathToFileURL(path.join(dir, 'src', 'index.ts')).href : entry.package;
    const { manifest } = (await import(entryFile)) as { manifest?: FeatureManifest };
    if (!manifest) fail(`${entry.package}: l'entrée racine n'exporte pas « manifest »`);
    try {
        validateManifest(manifest);
    } catch (e) {
        fail(`${entry.package}: ${(e as Error).message}`);
    }
    if (meta.id !== manifest.id)
        fail(`${entry.package}: deveye-feature.json.id (${meta.id}) ≠ manifest.id (${manifest.id})`);

    // Préfixe de table : ft_<slug>_ (slug = l'id sans son « x- »), l'allowlist
    // couvrant les tables historiques d'une native rapatriée.
    const slug = manifest.id.replace(/^x-/, '');
    const prefix = `ft_${slug}_`;
    const allowed = new Set(meta.tables ?? []);
    const migrationsDir = path.join(dir, 'src', 'server', 'migrations');
    if (fs.existsSync(migrationsDir)) {
        for (const file of fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql'))
            .sort()) {
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            for (const table of sqlTableTargets(sql)) {
                if (!table.startsWith(prefix) && !allowed.has(table)) {
                    fail(
                        `${entry.package}: ${file} touche « ${table} », hors du préfixe ${prefix} ` +
                            `(ou de l'allowlist deveye-feature.json.tables)`
                    );
                }
            }
        }
    }

    // Le SQL de démontage (scripts/uninstall-feature.ts) : il ne peut détruire
    // QUE les tables du préfixe — l'allowlist ne s'applique pas, les tables
    // historiques d'une native rapatriée sont des données de l'app.
    const uninstallPath = path.join(dir, 'src', 'server', 'uninstall.sql');
    if (fs.existsSync(uninstallPath)) {
        const outlaw = forbiddenUninstallTargets(manifest.id, fs.readFileSync(uninstallPath, 'utf8'));
        if (outlaw.length > 0) {
            fail(`${entry.package}: uninstall.sql touche ${outlaw.join(', ')}, hors du préfixe ${prefix}`);
        }
    }

    // Icône : embarquée (assets/icons/<icon>.svg, copiée sous nom préfixé) ou
    // classe déjà existante de l'app (une native rapatriée garde la sienne).
    const iconSource = path.join(dir, 'assets', 'icons', `${manifest.icon}.svg`);
    if (fs.existsSync(iconSource)) {
        return { pkg: entry.package, dir, manifest, icon: `${manifest.id}-${manifest.icon}`, iconSource, localPath };
    }
    return { pkg: entry.package, dir, manifest, icon: manifest.icon, iconSource: null, localPath };
}

const HEADER = `/*
 * GÉNÉRÉ par \`npm run gen:features\` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (\`gen:features --check\`) refuse un fichier qui ne correspond plus à la config.
 */`;

const HEADER_LOCAL = `/*
 * GÉNÉRÉ par \`npm run gen:features\` depuis features.local.json (ou stub vide
 * sans elle). GITIGNORÉ : les modules privés de cette installation ne laissent
 * aucune trace dans le dépôt public. Ne pas éditer, ne pas committer.
 */`;

/** L'import d'un module : spécifieur de package, ou chemin relatif au fichier généré. */
function importPath(m: ResolvedModule, fromDir: string, sub: '' | '/server' | '/client'): string {
    if (m.localPath === null) return `${m.pkg}${sub}`;
    const target =
        sub === ''
            ? path.join(m.localPath, 'src', 'index.ts')
            : sub === '/server'
              ? path.join(m.localPath, 'src', 'server', 'index.ts')
              : path.join(m.localPath, 'src', 'client', 'index.tsx');
    // Sans extension : tsc (Bundler), tsx et vite la résolvent, et
    // allowImportingTsExtensions n'a pas à s'inviter dans l'app.
    const rel = path
        .relative(fromDir, target)
        .split(path.sep)
        .join('/')
        .replace(/\.tsx?$/, '');
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function serverFile(mods: ResolvedModule[]): string {
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${importPath(m, SERVER_GEN, '')}';\n` +
                `import { serverEntry as server${i} } from '${importPath(m, SERVER_GEN, '/server')}';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, server: server${i} }`)
        .join(',\n');
    return `${HEADER}
import type { InstalledFeatureModule } from '@/features/_sdk/register';
import { LOCAL_MODULES } from './installed.local';
${imports}

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
${entries}${entries ? ',' : ''}
    ...LOCAL_MODULES
];
`;
}

function serverLocalFile(mods: ResolvedModule[]): string {
    if (mods.length === 0) {
        return `${HEADER_LOCAL}
import type { InstalledFeatureModule } from '@/features/_sdk/register';

export const LOCAL_MODULES: readonly InstalledFeatureModule[] = [];
`;
    }
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${importPath(m, SERVER_GEN, '')}';\n` +
                `import { serverEntry as server${i} } from '${importPath(m, SERVER_GEN, '/server')}';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, server: server${i} }`)
        .join(',\n');
    return `${HEADER_LOCAL}
import type { InstalledFeatureModule } from '@/features/_sdk/register';
${imports}

export const LOCAL_MODULES: readonly InstalledFeatureModule[] = [
${entries}
];
`;
}

function clientFile(mods: ResolvedModule[]): string {
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${importPath(m, CLIENT_GEN, '')}';\n` +
                `import { clientEntry as client${i} } from '${importPath(m, CLIENT_GEN, '/client')}';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, client: client${i} }`)
        .join(',\n');
    return `${HEADER}
import type { FeatureManifest } from 'deveye-types/sdk';
import type { FeatureClient } from 'deveye-types/sdk/client';

import { LOCAL_CLIENT_FEATURES } from './features.local';
${imports ? `${imports}\n` : ''}
export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}

export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [
${entries}${entries ? ',' : ''}
    ...LOCAL_CLIENT_FEATURES
];
`;
}

function clientLocalFile(mods: ResolvedModule[]): string {
    if (mods.length === 0) {
        return `${HEADER_LOCAL}
import type { InstalledClientFeature } from './features';

export const LOCAL_CLIENT_FEATURES: readonly InstalledClientFeature[] = [];
`;
    }
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${importPath(m, CLIENT_GEN, '')}';\n` +
                `import { clientEntry as client${i} } from '${importPath(m, CLIENT_GEN, '/client')}';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, client: client${i} }`)
        .join(',\n');
    return `${HEADER_LOCAL}
import type { InstalledClientFeature } from './features';
${imports}

export const LOCAL_CLIENT_FEATURES: readonly InstalledClientFeature[] = [
${entries}
];
`;
}

function iconsCss(mods: ResolvedModule[], local: boolean): string {
    const header = local
        ? `/*
 * GÉNÉRÉ : les icônes des modules PRIVÉS de cette installation. Gitignoré.
 */
`
        : `/*
 * GÉNÉRÉ par \`npm run gen:features\` : les icônes des modules installés,
 * copiées dans public/icons/ sous leur nom préfixé. Ne pas éditer.
 */
@import url(./icons.local.css);
`;
    const rules = mods
        .filter((m) => m.iconSource !== null)
        .map(
            (m) =>
                `.icon.icon-${m.icon} {\n    mask-image: url(/icons/${m.icon}.svg);\n    -webkit-mask-image: url(/icons/${m.icon}.svg);\n}\n`
        )
        .join('\n');
    return rules.length > 0 ? `${header}\n${rules}` : header;
}

interface Output {
    file: string;
    content: string;
}

function readConfig(file: string): ConfigEntry[] {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return [];
    return (JSON.parse(fs.readFileSync(full, 'utf8')) as { features?: ConfigEntry[] }).features ?? [];
}

async function resolveAll(entries: ConfigEntry[], forceLocal: boolean): Promise<ResolvedModule[]> {
    const mods: ResolvedModule[] = [];
    for (const entry of entries) {
        const mod = await resolveModule(entry);
        if (forceLocal && mod.localPath === null) {
            fail(`${entry.package}: une entrée de features.local.json doit porter un « path »`);
        }
        mods.push(mod);
    }
    return mods;
}

function writeOutputs(outputs: Output[], icons: { from: string; to: string }[]): void {
    for (const out of outputs) {
        fs.mkdirSync(path.dirname(out.file), { recursive: true });
        fs.writeFileSync(out.file, out.content);
    }
    for (const icon of icons) fs.copyFileSync(icon.from, icon.to);
}

function iconCopies(mods: ResolvedModule[]): { from: string; to: string }[] {
    return mods
        .filter((m) => m.iconSource !== null)
        .map((m) => ({ from: m.iconSource as string, to: path.join(ICONS_DIR, `${m.icon}.svg`) }));
}

async function main(): Promise<void> {
    const localMods = await resolveAll(readConfig('features.local.json'), true);
    const localOutputs: Output[] = [
        { file: path.join(SERVER_GEN, 'installed.local.ts'), content: serverLocalFile(localMods) },
        { file: path.join(CLIENT_GEN, 'features.local.ts'), content: clientLocalFile(localMods) },
        { file: path.join(STYLES_DIR, 'icons.local.css'), content: iconsCss(localMods, true) }
    ];

    if (ENSURE_LOCAL) {
        writeOutputs(localOutputs, iconCopies(localMods));
        console.log(`gen-features: fichiers locaux à jour (${localMods.length} module(s) privé(s))`);
        return;
    }

    const mods = await resolveAll(readConfig('features.config.json'), false);
    const seen = new Set<string>();
    for (const mod of [...mods, ...localMods]) {
        if (seen.has(mod.manifest.id)) fail(`id « ${mod.manifest.id} » déclaré deux fois (configs confondues)`);
        seen.add(mod.manifest.id);
    }

    const committedOutputs: Output[] = [
        { file: path.join(SERVER_GEN, 'installed.ts'), content: serverFile(mods) },
        { file: path.join(CLIENT_GEN, 'features.ts'), content: clientFile(mods) },
        { file: path.join(STYLES_DIR, 'icons.generated.css'), content: iconsCss(mods, false) }
    ];

    if (CHECK) {
        const stale: string[] = [];
        for (const out of committedOutputs) {
            const current = fs.existsSync(out.file) ? fs.readFileSync(out.file, 'utf8') : '';
            if (current !== out.content) stale.push(path.relative(ROOT, out.file));
        }
        for (const icon of iconCopies(mods)) {
            const same =
                fs.existsSync(icon.to) && fs.readFileSync(icon.to, 'utf8') === fs.readFileSync(icon.from, 'utf8');
            if (!same) stale.push(path.relative(ROOT, icon.to));
        }
        if (stale.length > 0) {
            fail(`fichiers générés en retard sur la config : ${stale.join(', ')}. Lancez \`npm run gen:features\`.`);
        }
        // Les locaux ne se vérifient pas, ils se réparent : gitignorés, ils ne
        // peuvent pas mettre la CI en échec, mais le typecheck qui suit exige
        // leur présence.
        writeOutputs(localOutputs, iconCopies(localMods));
        console.log(`gen-features: à jour (${mods.length} module(s), ${localMods.length} privé(s))`);
        return;
    }

    writeOutputs([...committedOutputs, ...localOutputs], [...iconCopies(mods), ...iconCopies(localMods)]);
    console.log(`gen-features: ${mods.length} module(s) + ${localMods.length} privé(s), glue régénérée`);
}

void main();
