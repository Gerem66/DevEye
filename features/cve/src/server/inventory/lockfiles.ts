/**
 * La lecture des fichiers de verrouillage : de quoi le dépôt dépend, à quelle
 * version exactement.
 *
 * Les verrous seulement, jamais les manifestes (`package.json`, `Cargo.toml`) :
 * une plage de versions ne dit pas ce qui est installé, et un constat qui
 * repose sur une plage ne se vérifie pas.
 *
 * Fonctions pures, testables sans réseau ni disque : c'est là que se joue la
 * justesse de la veille des dépendances.
 */

/** Les écosystèmes d'OSV que ce module sait reconnaître. */
export type Ecosystem =
    | 'npm'
    | 'crates.io'
    | 'PyPI'
    | 'Go'
    | 'Packagist'
    | 'RubyGems'
    | 'Pub'
    | 'NuGet'
    | 'Maven'
    | 'Hex'
    | 'SwiftURL'
    | 'GitHub Actions';

export interface Dependency {
    ecosystem: Ecosystem;
    name: string;
    version: string;
}

/** Les noms de fichiers qui portent un verrou, et l'écosystème de chacun. */
const LOCKFILES: Record<string, Ecosystem> = {
    'package-lock.json': 'npm',
    'npm-shrinkwrap.json': 'npm',
    'yarn.lock': 'npm',
    'pnpm-lock.yaml': 'npm',
    'Cargo.lock': 'crates.io',
    'poetry.lock': 'PyPI',
    'requirements.txt': 'PyPI',
    'go.sum': 'Go',
    'composer.lock': 'Packagist',
    'Gemfile.lock': 'RubyGems',
    'bun.lock': 'npm',
    'uv.lock': 'PyPI',
    'Pipfile.lock': 'PyPI',
    'pdm.lock': 'PyPI',
    'pubspec.lock': 'Pub',
    'packages.lock.json': 'NuGet',
    'gradle.lockfile': 'Maven',
    'mix.lock': 'Hex',
    'Package.resolved': 'SwiftURL',
    // La version de Go elle-même : sa bibliothèque standard a ses propres avis.
    'go.mod': 'Go'
};

/** Un workflow GitHub Actions : les actions qu'il emploie, en version exacte, sont des dépendances. */
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** Ce chemin est-il un verrou ? Le prédicat de l'analyseur. */
export function isLockfile(relPath: string): boolean {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    return base in LOCKFILES || WORKFLOW.test(relPath);
}

/**
 * Les dépendances d'un verrou, dédoublonnées. Un fichier illisible rend une
 * liste vide plutôt que de lever : un verrou tronqué ne doit pas faire échouer
 * le passage entier.
 */
export function parseLockfile(relPath: string, text: string): Dependency[] {
    if (WORKFLOW.test(relPath)) return dedupe(parseWorkflowActions(text));
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    const ecosystem = LOCKFILES[base];
    if (!ecosystem) return [];
    try {
        return dedupe(PARSERS[base](text, ecosystem));
    } catch {
        return [];
    }
}

function dedupe(deps: Dependency[]): Dependency[] {
    const seen = new Map<string, Dependency>();
    for (const d of deps) {
        if (!d.name || !d.version) continue;
        seen.set(`${d.ecosystem} ${d.name} ${d.version}`, d);
    }
    return [...seen.values()];
}

type Parser = (text: string, ecosystem: Ecosystem) => Dependency[];

function parseNpmLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const json = JSON.parse(text) as {
        packages?: Record<string, { version?: string; link?: boolean }>;
        dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
    };
    const out: Dependency[] = [];
    // Format v2/v3 : les clés sont des chemins. La racine (clé vide) est le
    // projet lui-même, et un « link » est un lien local, pas un paquet publié.
    for (const [key, value] of Object.entries(json.packages ?? {})) {
        if (!key || value.link) continue;
        const marker = 'node_modules/';
        const cut = key.lastIndexOf(marker);
        if (cut < 0) continue;
        const name = key.slice(cut + marker.length);
        if (value.version) out.push({ ecosystem, name, version: value.version });
    }
    if (out.length > 0) return out;
    // Format v1 : un arbre imbriqué de `dependencies`.
    const walk = (node: Record<string, { version?: string; dependencies?: unknown }>): void => {
        for (const [name, value] of Object.entries(node)) {
            if (value.version) out.push({ ecosystem, name, version: value.version });
            if (value.dependencies) {
                walk(value.dependencies as Record<string, { version?: string; dependencies?: unknown }>);
            }
        }
    };
    walk(json.dependencies ?? {});
    return out;
}

function parseYarnLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    let pending: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.trim() === '' || line.startsWith('#')) continue;
        if (!/^\s/.test(line)) {
            // L'en-tête d'une entrée : une ou plusieurs demandes séparées par
            // des virgules, chacune de la forme « nom@plage ».
            pending = line
                .replace(/:$/, '')
                .split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''))
                .map((s) => {
                    const at = s.lastIndexOf('@');
                    return at <= 0 ? '' : s.slice(0, at);
                })
                .filter(Boolean);
            continue;
        }
        const m = line.match(/^\s+version:?\s+"?([^"\s]+)"?\s*$/);
        if (m && pending.length > 0) {
            for (const name of pending) out.push({ ecosystem, name, version: m[1] });
            pending = [];
        }
    }
    return out;
}

function parsePnpmLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    for (const raw of text.split('\n')) {
        // Les deux formes que pnpm a écrites : « /nom/version: » (v5 et avant)
        // et « /nom@version: » (v6 et après), le nom pouvant être « scopé ».
        const m = raw.match(/^ {2}'?\/(@?[^@:'\s]+(?:\/[^@:'\s]+)?)[@/]([0-9][^:'\s(]*)/);
        if (m) out.push({ ecosystem, name: m[1], version: m[2] });
    }
    return out;
}

/** Les verrous en TOML de Cargo, Poetry, uv et PDM : mêmes tables `[[package]]`. */
function parseTomlPackages(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    let name = '';
    let version = '';
    let inPackage = false;
    const flush = (): void => {
        if (inPackage && name && version) out.push({ ecosystem, name, version });
        name = '';
        version = '';
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[[')) {
            flush();
            inPackage = line === '[[package]]';
            continue;
        }
        if (line.startsWith('[')) {
            flush();
            inPackage = false;
            continue;
        }
        if (!inPackage) continue;
        const m = line.match(/^(name|version)\s*=\s*"([^"]*)"/);
        if (m?.[1] === 'name') name = m[2];
        if (m?.[1] === 'version') version = m[2];
    }
    flush();
    return out;
}

function parseRequirements(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        // « == » seulement : « >= » ne dit pas ce qui est installé.
        const m = line.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9._+-]+)/);
        if (m) out.push({ ecosystem, name: m[1].toLowerCase(), version: m[2] });
    }
    return out;
}

function parseGoSum(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    for (const raw of text.split('\n')) {
        const parts = raw.trim().split(/\s+/);
        // Deux lignes par module : celle de l'archive et celle du `go.mod`. La
        // seconde ne dirait rien de plus.
        if (parts.length < 3 || parts[1].endsWith('/go.mod')) continue;
        out.push({ ecosystem, name: parts[0], version: parts[1] });
    }
    return out;
}

function parseComposerLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const json = JSON.parse(text) as {
        packages?: { name?: string; version?: string }[];
        'packages-dev'?: { name?: string; version?: string }[];
    };
    const all = [...(json.packages ?? []), ...(json['packages-dev'] ?? [])];
    return all
        .filter((p): p is { name: string; version: string } => Boolean(p.name && p.version))
        .map((p) => ({ ecosystem, name: p.name, version: p.version.replace(/^v/, '') }));
}

function parseGemfileLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    let inSpecs = false;
    for (const raw of text.split('\n')) {
        if (/^ {2}specs:\s*$/.test(raw)) {
            inSpecs = true;
            continue;
        }
        if (inSpecs && /^\S/.test(raw)) inSpecs = false;
        if (!inSpecs) continue;
        // Quatre espaces : la gemme elle-même. Six : ses propres exigences.
        const m = raw.match(/^ {4}([A-Za-z0-9._-]+)\s+\(([^)]+)\)\s*$/);
        if (m) out.push({ ecosystem, name: m[1], version: m[2] });
    }
    return out;
}

/** `bun.lock` (JSONC) : `"nom": ["nom@version", …]`. Les liens locaux et les dépôts n'ont pas de version publiée. */
function parseBunLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    const entry = /^\s*"[^"]+":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm;
    for (let m = entry.exec(text); m !== null; m = entry.exec(text)) {
        if (/^\d/.test(m[2])) out.push({ ecosystem, name: m[1], version: m[2] });
    }
    return out;
}

function parsePipfileLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const json = JSON.parse(text) as Record<string, Record<string, { version?: string }> | undefined>;
    const out: Dependency[] = [];
    for (const section of ['default', 'develop']) {
        for (const [name, spec] of Object.entries(json[section] ?? {})) {
            const version = spec.version?.replace(/^==/, '');
            if (version) out.push({ ecosystem, name: name.toLowerCase(), version });
        }
    }
    return out;
}

/** `pubspec.lock` : un paquet par clé à deux espaces, sa version à quatre. */
function parsePubspecLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    let name = '';
    for (const raw of text.split('\n')) {
        const key = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(raw);
        if (key) {
            name = key[1];
            continue;
        }
        const version = /^ {4}version:\s*"?([^"\s]+)"?\s*$/.exec(raw);
        if (version && name) out.push({ ecosystem, name, version: version[1] });
    }
    return out;
}

function parseNugetLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const json = JSON.parse(text) as { dependencies?: Record<string, Record<string, { resolved?: string }>> };
    const out: Dependency[] = [];
    for (const framework of Object.values(json.dependencies ?? {})) {
        for (const [name, spec] of Object.entries(framework)) {
            if (spec.resolved) out.push({ ecosystem, name, version: spec.resolved });
        }
    }
    return out;
}

/** `gradle.lockfile` : `groupe:artefact:version=configurations`. */
function parseGradleLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    for (const raw of text.split('\n')) {
        const m = /^([\w.-]+):([\w.-]+):([^=\s]+)=/.exec(raw.trim());
        if (m) out.push({ ecosystem, name: `${m[1]}:${m[2]}`, version: m[3] });
    }
    return out;
}

/** `mix.lock` : `"nom": {:hex, :paquet, "version", …}`. */
function parseMixLock(text: string, ecosystem: Ecosystem): Dependency[] {
    const out: Dependency[] = [];
    const entry = /\{:hex,\s*:([\w]+),\s*"([^"]+)"/g;
    for (let m = entry.exec(text); m !== null; m = entry.exec(text)) out.push({ ecosystem, name: m[1], version: m[2] });
    return out;
}

/** `Package.resolved` de SwiftPM, formats 1 à 3 : OSV nomme un paquet par son adresse, sans protocole. */
function parsePackageResolved(text: string, ecosystem: Ecosystem): Dependency[] {
    type Pin = { location?: string; repositoryURL?: string; state?: { version?: string } };
    const json = JSON.parse(text) as { pins?: Pin[]; object?: { pins?: Pin[] } };
    const out: Dependency[] = [];
    for (const pin of json.pins ?? json.object?.pins ?? []) {
        const url = pin.location ?? pin.repositoryURL;
        const version = pin.state?.version;
        if (!url || !version) continue;
        out.push({ ecosystem, name: url.replace(/^https?:\/\//, '').replace(/\.git$/, ''), version });
    }
    return out;
}

/**
 * `go.mod` : la version de Go, pour la bibliothèque standard. La directive
 * `toolchain` dit ce qui compile ; `go` n'en dit autant qu'avec trois
 * nombres, sinon elle ne fixe qu'un minimum.
 */
function parseGoMod(text: string, ecosystem: Ecosystem): Dependency[] {
    const toolchain = /^toolchain\s+go(\d+\.\d+\.\d+)\s*$/m.exec(text);
    const go = /^go\s+(\d+\.\d+\.\d+)\s*$/m.exec(text);
    const version = toolchain?.[1] ?? go?.[1];
    return version ? [{ ecosystem, name: 'stdlib', version }] : [];
}

/** Les actions d'un workflow en version exacte : `@v4` suit les correctifs, rien ne se compare. */
function parseWorkflowActions(text: string): Dependency[] {
    const out: Dependency[] = [];
    const uses = /^\s*(?:-\s+)?uses:\s*['"]?([\w.-]+\/[\w.-]+)(?:\/[^@\s'"]*)?@v?(\d+\.\d+\.\d+)\b/gm;
    for (let m = uses.exec(text); m !== null; m = uses.exec(text)) {
        out.push({ ecosystem: 'GitHub Actions', name: m[1], version: m[2] });
    }
    return out;
}

const PARSERS: Record<string, Parser> = {
    'package-lock.json': parseNpmLock,
    'npm-shrinkwrap.json': parseNpmLock,
    'yarn.lock': parseYarnLock,
    'pnpm-lock.yaml': parsePnpmLock,
    'Cargo.lock': parseTomlPackages,
    'poetry.lock': parseTomlPackages,
    'requirements.txt': parseRequirements,
    'go.sum': parseGoSum,
    'composer.lock': parseComposerLock,
    'Gemfile.lock': parseGemfileLock,
    'bun.lock': parseBunLock,
    'uv.lock': parseTomlPackages,
    'Pipfile.lock': parsePipfileLock,
    'pdm.lock': parseTomlPackages,
    'pubspec.lock': parsePubspecLock,
    'packages.lock.json': parseNugetLock,
    'gradle.lockfile': parseGradleLock,
    'mix.lock': parseMixLock,
    'Package.resolved': parsePackageResolved,
    'go.mod': parseGoMod
};
