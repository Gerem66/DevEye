import type { SourceFormat } from '../../contracts/catalogue';
import { cropRect, imageDims } from '../../contracts/geometry';
import { cropOf, flag, num, sizeOf } from '../../contracts/options';
import { env } from '../env';
import { captureTool, ConvertFailure, runTool } from '../spawn';
import type { EngineJob, InputProbe } from './types';

/**
 * Les images passent par ImageMagick, hors du processus du serveur : un
 * décodeur qui s'effondre sur un fichier hostile n'emporte que lui. Les limites
 * de ressources sont posées deux fois, ici et dans `policy/policy.xml` : une
 * politique ne se contourne pas par un argument, un argument protège un poste
 * où la politique n'est pas installée.
 */

const MAX_DIMENSION = 16_384;
const IMAGE_TIMEOUT_MS = 180_000;

const LIMITS = [
    '-limit',
    'memory',
    '512MiB',
    '-limit',
    'map',
    '1GiB',
    '-limit',
    'disk',
    '4GiB',
    '-limit',
    'area',
    '256MP',
    '-limit',
    'thread',
    '2'
] as const;

/** `magick` (version 7) ou, à défaut, `convert` (version 6). Résolu une fois par la sonde de présence. */
let binary: 'magick' | 'convert' = 'magick';
export function setImageBinary(next: 'magick' | 'convert'): void {
    binary = next;
}

/**
 * Le codeur est imposé devant le chemin (`JPEG:in.bin`) : ImageMagick ne devine
 * rien, et un fichier qui n'est pas ce qu'il annonce échoue au lieu d'être lu
 * par un codeur qu'on n'a pas choisi. `[0]` : la première image d'un fichier
 * qui en porte plusieurs.
 */
const reading = (source: SourceFormat, inputPath: string): string => `${source.readers?.[0] ?? ''}:${inputPath}[0]`;

export async function probeImage(
    source: SourceFormat,
    inputPath: string,
    workDir: string,
    inputBytes: number
): Promise<InputProbe> {
    let raw: string;
    try {
        raw = await captureTool(
            binary === 'magick' ? 'magick' : 'identify',
            [...(binary === 'magick' ? ['identify'] : []), ...LIMITS, '-format', '%w %h', reading(source, inputPath)],
            workDir,
            IMAGE_TIMEOUT_MS
        );
    } catch (e) {
        if (e instanceof ConvertFailure && e.code === 'engine_missing') throw e;
        throw new ConvertFailure(
            'format_mismatch',
            `Ce fichier ne se lit pas comme un ${source.label} : il est abîmé, ou ce n’est pas ce que son nom annonce.`
        );
    }
    const [width, height] = raw.trim().split(/\s+/).map(Number);
    if (!width || !height) throw new ConvertFailure('corrupt', 'Les dimensions de cette image ne se lisent pas.');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new ConvertFailure('unsupported', `Image trop grande : ${MAX_DIMENSION} pixels de côté au plus.`);
    }
    return {
        bytes: inputBytes,
        durationMs: null,
        width,
        height,
        fps: null,
        audioKbps: null,
        reader: source.readers?.[0] ?? null,
        hasAudio: false,
        pages: null
    };
}

type PlanInput = Pick<EngineJob, 'source' | 'target' | 'options' | 'probe' | 'paths'>;

export function imageArgs(job: PlanInput): string[] {
    const recipe = job.target.recipe;
    if (recipe.engine !== 'image') throw new Error('Recette image attendue');
    const source = { width: job.probe.width ?? 0, height: job.probe.height ?? 0 };
    const crop = cropRect(source, cropOf(job.options, 'crop'));
    const dims = imageDims(source, cropOf(job.options, 'crop'), sizeOf(job.options, 'resize'));
    const resized = dims.width !== (crop?.width ?? source.width) || dims.height !== (crop?.height ?? source.height);
    return [
        ...LIMITS,
        reading(job.source, job.paths.input),
        // Avant tout le reste : sans elle une photo de téléphone sort couchée dès
        // que ses informations cachées, qui portaient l'orientation, sont retirées.
        '-auto-orient',
        ...(crop ? ['-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage'] : []),
        // `!` : les dimensions sont déjà calculées, ImageMagick n'a plus à les ajuster.
        ...(resized ? ['-resize', `${dims.width}x${dims.height}!`] : []),
        // Tout sauf le profil de couleur : `-strip` l'emporterait aussi, et une photo en gamut large sortirait terne.
        ...(flag(job.options, 'stripMetadata') ? ['+profile', '!icc,*', '-set', 'comment', ''] : []),
        ...(recipe.alpha ? [] : ['-background', 'white', '-alpha', 'remove', '-alpha', 'off']),
        ...(recipe.lossy ? ['-quality', String(num(job.options, 'quality') ?? 82)] : []),
        `${recipe.coder}:${job.paths.outputPart}`
    ];
}

export async function runImage(job: EngineJob, maxOutputBytes: number): Promise<void> {
    await runTool({
        bin: binary,
        args: imageArgs(job),
        workDir: job.paths.work,
        signal: job.signal,
        timeoutMs: IMAGE_TIMEOUT_MS,
        watchFile: job.paths.outputPart,
        maxOutputBytes,
        env: { MAGICK_TEMPORARY_PATH: job.paths.work, MAGICK_THREAD_LIMIT: String(Math.min(2, env.CONVERT_THREADS)) }
    });
    job.onProgress(1000);
}

/** Les codeurs que CETTE installation sait lire, et écrire : d'après `-list format`. */
export async function imageCoders(workDir: string): Promise<{ read: Set<string>; write: Set<string> }> {
    const raw = await captureTool(binary, ['-list', 'format'], workDir, 20_000);
    const read = new Set<string>();
    const write = new Set<string>();
    for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9-]+)\*?\s+\S+\s+([r-])([w-])[+-]/.exec(line);
        if (!match) continue;
        if (match[2] === 'r') read.add(match[1]);
        if (match[3] === 'w') write.add(match[1]);
    }
    return { read, write };
}
