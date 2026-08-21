/**
 * Génère la glue des modules de features depuis `features.config.json`.
 *
 * Sorties (commitées, le serveur n'ayant aucune étape de build) :
 *  - `src/features/_generated/installed.ts` (manifests + entrées serveur) ;
 *  - `client/src/generated/features.ts` (manifests + entrées client) ;
 *  - `client/src/Styles/icons.generated.css` + copie des SVG des modules dans
 *    `client/public/icons/` sous leur nom préfixé (`<id>-<icône>.svg`).
 *
 * `--check` régénère en mémoire et compare aux fichiers du dépôt : toute
 * dérive fait échouer la CI avec le remède en une ligne.
 *
 * Le générateur est aussi la première sentinelle : ids valides et uniques,
 * version minimale de deveye-types, et préfixe de table `ft_<slug>_` vérifié
 * par balayage statique des migrations SQL (allowlist `deveye-feature.json`
 * pour les tables historiques d'une native rapatriée).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { validateManifest, type FeatureManifest } from 'deveye-types/sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const CHECK = process.argv.includes('--check');

interface ConfigEntry {
    package: string;
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

/** Les tables visées par les DDL d'un fichier de migration. Balayage conservateur. */
function sqlTableTargets(sql: string): string[] {
    const targets: string[] = [];
    const patterns = [
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /ALTER\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi,
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /RENAME\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+[`"]?([A-Za-z0-9_]+)/gi
    ];
    for (const re of patterns) {
        for (let m = re.exec(sql); m !== null; m = re.exec(sql)) targets.push(m[1]);
    }
    return targets;
}

async function resolveModule(entry: ConfigEntry): Promise<ResolvedModule> {
    let pkgJsonPath: string;
    try {
        pkgJsonPath = require.resolve(`${entry.package}/package.json`);
    } catch {
        fail(`« ${entry.package} » est dans features.config.json mais introuvable dans node_modules (npm install ?)`);
    }
    const dir = path.dirname(pkgJsonPath);

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

    const { manifest } = (await import(entry.package)) as { manifest?: FeatureManifest };
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

    // Icône : embarquée (assets/icons/<icon>.svg, copiée sous nom préfixé) ou
    // classe déjà existante de l'app (une native rapatriée garde la sienne).
    const iconSource = path.join(dir, 'assets', 'icons', `${manifest.icon}.svg`);
    if (fs.existsSync(iconSource)) {
        return { pkg: entry.package, dir, manifest, icon: `${manifest.id}-${manifest.icon}`, iconSource };
    }
    return { pkg: entry.package, dir, manifest, icon: manifest.icon, iconSource: null };
}

const HEADER = `/*
 * GÉNÉRÉ par \`npm run gen:features\` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (\`gen:features --check\`) refuse un fichier qui ne correspond plus à la config.
 */`;

function serverFile(mods: ResolvedModule[]): string {
    if (mods.length === 0) {
        return `${HEADER}
import type { InstalledFeatureModule } from '@/features/_sdk/register';

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [];
`;
    }
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${m.pkg}';\nimport { serverEntry as server${i} } from '${m.pkg}/server';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, server: server${i} }`)
        .join(',\n');
    return `${HEADER}
import type { InstalledFeatureModule } from '@/features/_sdk/register';
${imports}

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
${entries}
];
`;
}

function clientFile(mods: ResolvedModule[]): string {
    const base = `${HEADER}
import type { FeatureManifest } from 'deveye-types/sdk';
import type { FeatureClient } from 'deveye-types/sdk/client';

export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}
`;
    if (mods.length === 0) {
        return `${base}
export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [];
`;
    }
    const imports = mods
        .map(
            (m, i) =>
                `import { manifest as manifest${i} } from '${m.pkg}';\nimport { clientEntry as client${i} } from '${m.pkg}/client';`
        )
        .join('\n');
    const entries = mods
        .map((m, i) => `    { manifest: { ...manifest${i}, icon: '${m.icon}' }, client: client${i} }`)
        .join(',\n');
    return `${base}${imports}

export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [
${entries}
];
`;
}

function iconsCss(mods: ResolvedModule[]): string {
    const header = `/*
 * GÉNÉRÉ par \`npm run gen:features\` : les icônes des modules installés,
 * copiées dans public/icons/ sous leur nom préfixé. Ne pas éditer.
 */
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

async function main(): Promise<void> {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'features.config.json'), 'utf8')) as {
        features: ConfigEntry[];
    };
    const mods: ResolvedModule[] = [];
    const seen = new Set<string>();
    for (const entry of config.features) {
        const mod = await resolveModule(entry);
        if (seen.has(mod.manifest.id)) fail(`id « ${mod.manifest.id} » déclaré deux fois`);
        seen.add(mod.manifest.id);
        mods.push(mod);
    }

    const outputs: { file: string; content: string }[] = [
        { file: path.join(ROOT, 'src', 'features', '_generated', 'installed.ts'), content: serverFile(mods) },
        { file: path.join(ROOT, 'client', 'src', 'generated', 'features.ts'), content: clientFile(mods) },
        { file: path.join(ROOT, 'client', 'src', 'Styles', 'icons.generated.css'), content: iconsCss(mods) }
    ];
    const icons = mods
        .filter((m) => m.iconSource !== null)
        .map((m) => ({
            from: m.iconSource as string,
            to: path.join(ROOT, 'client', 'public', 'icons', `${m.icon}.svg`)
        }));

    if (CHECK) {
        const stale: string[] = [];
        for (const out of outputs) {
            const current = fs.existsSync(out.file) ? fs.readFileSync(out.file, 'utf8') : '';
            if (current !== out.content) stale.push(path.relative(ROOT, out.file));
        }
        for (const icon of icons) {
            const same =
                fs.existsSync(icon.to) && fs.readFileSync(icon.to, 'utf8') === fs.readFileSync(icon.from, 'utf8');
            if (!same) stale.push(path.relative(ROOT, icon.to));
        }
        if (stale.length > 0) {
            fail(`fichiers générés en retard sur la config : ${stale.join(', ')}. Lancez \`npm run gen:features\`.`);
        }
        console.log(`gen-features: à jour (${mods.length} module(s))`);
        return;
    }

    for (const out of outputs) {
        fs.mkdirSync(path.dirname(out.file), { recursive: true });
        fs.writeFileSync(out.file, out.content);
    }
    for (const icon of icons) fs.copyFileSync(icon.from, icon.to);
    console.log(`gen-features: ${mods.length} module(s), ${outputs.length} fichiers générés`);
}

void main();
