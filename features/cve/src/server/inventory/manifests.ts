import type { FormatId } from '../../contracts/formats';
import type { Ecosystem } from './lockfiles';

/**
 * Les dépendances qu'un projet déclare lui-même, par ses manifestes : ce que
 * son auteur a choisi, et peut monter de version. Une dépendance tirée par une
 * autre ne se met pas à jour seule : c'est celle-ci qui vieillit pour de bon.
 * Les noms seulement : la version retenue est celle du verrou voisin.
 */

export interface Manifest {
    format: FormatId;
    ecosystem: Ecosystem;
    names: string[];
}

const MANIFESTS: Record<string, FormatId> = {
    'package.json': 'package.json',
    'Cargo.toml': 'Cargo.toml',
    'pyproject.toml': 'pyproject.toml',
    Gemfile: 'Gemfile'
};

export function isManifest(path: string): boolean {
    return path.slice(path.lastIndexOf('/') + 1) in MANIFESTS;
}

/** Un nom PyPI tel que les verrous l'écrivent : minuscules, tirets. */
function pypiName(raw: string): string {
    return raw.trim().toLowerCase().replace(/[_.]+/g, '-');
}

function packageJson(text: string): string[] {
    const json = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((key) => Object.keys(json[key] ?? {}));
}

/** Les clés des tables de dépendances d'un TOML : `name = "1.0"` ou `name = { … }`. */
function tomlTables(text: string, tables: readonly RegExp[]): string[] {
    const names: string[] = [];
    let inTable = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inTable = tables.some((t) => t.test(line));
            continue;
        }
        const m = inTable ? /^([A-Za-z0-9_.-]+)\s*=/.exec(line) : null;
        if (m) names.push(m[1]);
    }
    return names;
}

function pyproject(text: string): string[] {
    const names = tomlTables(text, [
        /^\[tool\.poetry\.(?:dev-)?dependencies\]$/,
        /^\[tool\.poetry\.group\.[^\]]+\.dependencies\]$/
    ])
        .filter((n) => n.toLowerCase() !== 'python')
        .map(pypiName);
    // PEP 621 : `dependencies = ["requests>=2", …]`, sur une ou plusieurs lignes.
    const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
    for (const entry of block?.[1].matchAll(/["']([A-Za-z0-9_.-]+)/g) ?? []) names.push(pypiName(entry[1]));
    return names;
}

function gemfile(text: string): string[] {
    return [...text.matchAll(/^\s*gem\s+["']([A-Za-z0-9_.-]+)["']/gm)].map((m) => m[1]);
}

/** Ce qu'un manifeste déclare. Un fichier illisible ne déclare rien, il ne fait pas échouer la lecture. */
export function parseManifest(path: string, text: string): Manifest | null {
    const format = MANIFESTS[path.slice(path.lastIndexOf('/') + 1)];
    if (!format) return null;
    try {
        switch (format) {
            case 'package.json':
                return { format, ecosystem: 'npm', names: packageJson(text) };
            case 'Cargo.toml':
                return {
                    format,
                    ecosystem: 'crates.io',
                    names: tomlTables(text, [
                        /^\[(?:dev-|build-)?dependencies\]$/,
                        /^\[workspace\.dependencies\]$/,
                        /^\[target\.[^\]]+\.dependencies\]$/
                    ])
                };
            case 'pyproject.toml':
                return { format, ecosystem: 'PyPI', names: pyproject(text) };
            default:
                return { format, ecosystem: 'RubyGems', names: gemfile(text) };
        }
    } catch {
        return null;
    }
}

/** Les modules qu'un `go.mod` requiert lui-même : ceux que `// indirect` ne marque pas. */
export function goDirect(text: string): string[] {
    const names: string[] = [];
    let inBlock = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (/^require\s*\($/.test(line)) {
            inBlock = true;
            continue;
        }
        if (inBlock && line === ')') {
            inBlock = false;
            continue;
        }
        const entry = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
        if (!entry || entry.includes('// indirect')) continue;
        const name = entry.split(/\s+/)[0];
        if (name) names.push(name);
    }
    return names;
}
