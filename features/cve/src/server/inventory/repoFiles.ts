import type { AssetFormat, ExposureComponent } from '../../contracts/exposure';
import { formatIdSchema, type FormatId } from '../../contracts/formats';
import { isLockfile, parseLockfile } from './lockfiles';
import { findTools, isToolFile, TOOLS } from './tools';

/** Des copies de dépendances tierces, que le dépôt n'écrit pas lui-même : leurs verrous ne sont pas les siens. */
const VENDORED = /(^|\/)(?:node_modules|vendor|bower_components)\//;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** Ce que la veille demande à lire d'un dépôt. */
export function wantsRepoFile(path: string): boolean {
    if (VENDORED.test(path)) return false;
    return isLockfile(path) || isToolFile(path);
}

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
                    line: t.line
                });
            }
        }
    }
    return { components: [...components.values()], formats };
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
