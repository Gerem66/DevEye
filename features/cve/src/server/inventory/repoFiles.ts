import type { AssetFormat, ExposureComponent } from '../../contracts/exposure';
import { formatIdSchema, type FormatId } from '../../contracts/formats';
import { isLockfile, parseLockfile } from './lockfiles';
import { goDirect, isManifest, parseManifest } from './manifests';
import { findTools, isToolFile, TOOLS } from './tools';

/** Des copies de dépendances tierces, que le dépôt n'écrit pas lui-même : leurs verrous ne sont pas les siens. */
const VENDORED = /(^|\/)(?:node_modules|vendor|bower_components)\//;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** Ce que la veille demande à lire d'un dépôt. */
export function wantsRepoFile(path: string): boolean {
    if (VENDORED.test(path)) return false;
    return isLockfile(path) || isToolFile(path) || isManifest(path);
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

function lockFormat(path: string): FormatId | null {
    if (WORKFLOW.test(path)) return 'github-workflow';
    const parsed = formatIdSchema.safeParse(path.slice(path.lastIndexOf('/') + 1));
    return parsed.success ? parsed.data : null;
}

export interface RepoInventory {
    components: ExposureComponent[];
    formats: AssetFormat[];
}

/**
 * L'inventaire d'un dépôt, depuis ses fichiers : un composant par paquet ou
 * outil distinct (le premier fichier qui le nomme gagne, le constat pointe un
 * fichier), et chaque fichier reconnu avec ce qu'il a donné.
 */
export function inventoryOfFiles(files: readonly { path: string; text: string }[]): RepoInventory {
    const components = new Map<string, ExposureComponent>();
    const formats: AssetFormat[] = [];
    const add = (c: ExposureComponent): void => {
        const key = `${c.kind}|${c.ecosystem}|${c.name}|${c.version}`;
        if (!components.has(key)) components.set(key, c);
    };

    for (const file of files) {
        if (isLockfile(file.path)) {
            const format = lockFormat(file.path);
            const deps = parseLockfile(file.path, file.text);
            if (format) formats.push({ format, path: file.path, count: deps.length });
            for (const d of deps) {
                add({
                    kind: 'package',
                    ecosystem: d.ecosystem,
                    name: d.name,
                    version: d.version,
                    format: format ?? 'package-lock.json',
                    path: file.path,
                    line: null
                });
            }
        }
        if (isToolFile(file.path)) {
            const tools = findTools(file.path, file.text);
            const byFormat = new Map<FormatId, number>();
            for (const t of tools) byFormat.set(t.format, (byFormat.get(t.format) ?? 0) + 1);
            // Un package.json sans `engines` n'apprend rien sur les outils : il
            // n'est lu que pour cette clé.
            const base = file.path.slice(file.path.lastIndexOf('/') + 1);
            if (byFormat.size === 0 && base !== 'package.json') {
                const format = toolFormatOf(file.path);
                if (format) byFormat.set(format, 0);
            }
            for (const [format, count] of byFormat) formats.push({ format, path: file.path, count });
            for (const t of tools) {
                add({
                    kind: 'product',
                    ecosystem: t.tool,
                    name: TOOLS[t.tool].label,
                    version: t.version,
                    format: t.format,
                    path: t.path,
                    line: t.line,
                    ...(t.exact ? {} : { exact: false })
                });
            }
        }
    }
    markDirect(files, components, formats);
    return { components: [...components.values()], formats };
}

/**
 * Marque les paquets que le projet déclare lui-même : ceux qu'un manifeste du
 * dossier de leur verrou nomme. Tout ce qu'épingle un `requirements.txt` est
 * déclaré par définition.
 */
function markDirect(
    files: readonly { path: string; text: string }[],
    components: Map<string, ExposureComponent>,
    formats: AssetFormat[]
): void {
    const declared = new Map<string, Set<string>>();
    const declare = (dir: string, ecosystem: string, names: readonly string[]): void => {
        const key = `${dir}|${ecosystem}`;
        const set = declared.get(key) ?? new Set<string>();
        for (const n of names) set.add(n);
        declared.set(key, set);
    };
    for (const file of files) {
        const manifest = parseManifest(file.path, file.text);
        if (manifest) {
            declare(dirOf(file.path), manifest.ecosystem, manifest.names);
            formats.push({ format: manifest.format, path: file.path, count: manifest.names.length });
        }
        if (file.path.slice(file.path.lastIndexOf('/') + 1) === 'go.mod') {
            declare(dirOf(file.path), 'Go', goDirect(file.text));
        }
    }
    for (const [key, c] of components) {
        if (c.kind !== 'package' || c.path === null) continue;
        const direct =
            c.format === 'requirements.txt' || (declared.get(`${dirOf(c.path)}|${c.ecosystem}`)?.has(c.name) ?? false);
        if (direct) components.set(key, { ...c, direct: true });
    }
}

/** Le format d'un fichier d'outil qui n'a rien donné : un Dockerfile aux images flottantes reste un Dockerfile lu. */
function toolFormatOf(path: string): FormatId | null {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (/(?:^Dockerfile(?:\..+)?$|\.dockerfile$)/.test(base)) return 'Dockerfile';
    if (/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(base)) return 'compose';
    if (base === 'rust-toolchain' || base === 'rust-toolchain.toml') return 'rust-toolchain';
    const parsed = formatIdSchema.safeParse(base);
    return parsed.success ? parsed.data : null;
}
