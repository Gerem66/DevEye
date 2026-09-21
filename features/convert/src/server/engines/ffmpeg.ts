import type { SourceFormat } from '../../contracts/catalogue';
import { minTargetBytes, minVideoBitrate, videoBitrateForTarget } from '../../contracts/estimate';
import { cropRect, keptSeconds, videoDims } from '../../contracts/geometry';
import { cropOf, flag, num, str } from '../../contracts/options';
import { formatBytes } from '../_shared';
import { env } from '../env';
import { captureTool, ConvertFailure, runTool } from '../spawn';
import type { EngineJob, InputProbe } from './types';

/** Au-delà, ce n'est plus un cas d'usage mais une charge. */
const MAX_DIMENSION = 8192;
const PROBE_TIMEOUT_MS = 60_000;

/**
 * En tête de tout appel. `-protocol_whitelist file` : ni réseau, ni protocole
 * imbriqué. `-nostdin` : sans lui ffmpeg lit l'entrée standard du serveur.
 */
const SAFE_INPUT = ['-protocol_whitelist', 'file'] as const;
const QUIET = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'] as const;

interface FfprobeStream {
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    disposition?: { attached_pic?: number };
}
interface FfprobeOutput {
    format?: { format_name?: string; duration?: string };
    streams?: FfprobeStream[];
}

function frameRate(raw: string | undefined): number | null {
    const [a, b] = (raw ?? '').split('/').map(Number);
    if (!a || !b) return null;
    const fps = a / b;
    return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : null;
}

/**
 * Lit le fichier reçu. Ce que ffprobe reconnaît doit être l'un des lecteurs du
 * format annoncé : c'est ce qui écarte une liste de lecture (HLS, concat), qui
 * référence d'autres fichiers et ferait lire au serveur ce qu'on lui désigne.
 */
export async function probeMedia(
    source: SourceFormat,
    inputPath: string,
    workDir: string,
    inputBytes: number
): Promise<InputProbe> {
    let parsed: FfprobeOutput;
    try {
        const raw = await captureTool(
            'ffprobe',
            ['-v', 'error', ...SAFE_INPUT, '-print_format', 'json', '-show_format', '-show_streams', inputPath],
            workDir,
            PROBE_TIMEOUT_MS
        );
        parsed = JSON.parse(raw) as FfprobeOutput;
    } catch (e) {
        if (e instanceof ConvertFailure && e.code === 'engine_missing') throw e;
        throw new ConvertFailure(
            'corrupt',
            'Ce fichier ne se lit pas : il est abîmé, ou ce n’est pas ce que son nom annonce.'
        );
    }

    const recognised = (parsed.format?.format_name ?? '').split(',');
    const reader = (source.readers ?? []).find((r) => recognised.includes(r)) ?? null;
    if (!reader) {
        throw new ConvertFailure(
            'format_mismatch',
            `Ce fichier n’est pas un ${source.label} : choisir le format d’entrée qui lui correspond.`
        );
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const width = video?.width ?? null;
    const height = video?.height ?? null;
    if ((width ?? 0) > MAX_DIMENSION || (height ?? 0) > MAX_DIMENSION) {
        throw new ConvertFailure('unsupported', `Image trop grande : ${MAX_DIMENSION} pixels de côté au plus.`);
    }
    const seconds = Number(parsed.format?.duration);
    return {
        bytes: inputBytes,
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
        width,
        height,
        fps: frameRate(video?.avg_frame_rate),
        reader,
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
        pages: null
    };
}

/** Une conversion ffmpeg : un ou deux appels, et la durée gardée qui sert de dénominateur à l'avancement. */
export interface FfmpegPlan {
    passes: string[][];
    seconds: number;
}

type PlanInput = Pick<EngineJob, 'target' | 'options' | 'probe' | 'paths'>;

function inputArgs(job: PlanInput, seconds: number): string[] {
    const start = num(job.options, 'trimStart') ?? 0;
    const total = (job.probe.durationMs ?? 0) / 1000;
    const args = [...QUIET, ...SAFE_INPUT, '-f', job.probe.reader as string];
    // Avant `-i` : ffmpeg saute au passage au lieu de décoder tout ce qui précède.
    if (start > 0) args.push('-ss', String(start));
    if (seconds > 0 && seconds < total) args.push('-t', String(seconds));
    args.push('-i', job.paths.input);
    return args;
}

function requireVideo(job: PlanInput): { width: number; height: number } {
    if (!job.probe.width || !job.probe.height) {
        throw new ConvertFailure('unsupported', 'Ce fichier ne contient pas d’image.');
    }
    return { width: job.probe.width, height: job.probe.height };
}

export function videoPlan(job: PlanInput): FfmpegPlan {
    const recipe = job.target.recipe;
    if (recipe.engine !== 'video') throw new Error('Recette vidéo attendue');
    const source = requireVideo(job);
    const seconds = keptSeconds(job.probe.durationMs ?? 0, num(job.options, 'trimStart'), num(job.options, 'trimEnd'));

    const crop = cropRect(source, cropOf(job.options, 'crop'));
    const heightChoice = str(job.options, 'height');
    const dims = videoDims(
        source,
        cropOf(job.options, 'crop'),
        heightChoice && heightChoice !== 'source' ? Number(heightChoice) : null
    );
    const filters: string[] = [];
    if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    if (dims.width !== (crop?.width ?? source.width) || dims.height !== (crop?.height ?? source.height)) {
        filters.push(`scale=${dims.width}:${dims.height}`);
    }
    const fps = str(job.options, 'fps');
    if (fps && fps !== 'source') filters.push(`fps=${Number(fps)}`);

    const withAudio = flag(job.options, 'audio') && job.probe.hasAudio;
    const audioBitrate = withAudio ? (num(job.options, 'audioBitrate') ?? 128) * 1000 : 0;
    const speed = recipe.speed[(str(job.options, 'speed') ?? 'balanced') as keyof typeof recipe.speed];

    const picture = ['-map', '0:v:0', '-sn', '-dn', ...(filters.length ? ['-vf', filters.join(',')] : [])];
    const sound = withAudio ? ['-map', '0:a:0', '-c:a', recipe.audioCodec, '-b:a', String(audioBitrate)] : ['-an'];
    const tail = [
        ...(flag(job.options, 'stripMetadata') ? ['-map_metadata', '-1', '-map_chapters', '-1'] : []),
        '-threads',
        String(env.CONVERT_THREADS),
        '-max_muxing_queue_size',
        '1024',
        ...(recipe.extra ?? []),
        '-f',
        recipe.muxer,
        job.paths.outputPart
    ];
    const input = inputArgs(job, seconds);

    if (str(job.options, 'mode') !== 'size') {
        const quality = (num(job.options, 'quality') ?? 65) / 100;
        const crf = Math.round(recipe.crf.worst - quality * (recipe.crf.worst - recipe.crf.best));
        const encode = ['-c:v', recipe.videoCodec, '-crf', String(crf), ...(recipe.constantQuality ?? []), ...speed];
        return { passes: [[...input, ...picture, ...encode, ...sound, ...tail]], seconds };
    }

    if (seconds <= 0) {
        throw new ConvertFailure(
            'unsupported',
            'La durée de cette vidéo ne se lit pas : viser une taille est impossible.'
        );
    }
    const targetBytes = num(job.options, 'targetBytes') ?? 0;
    const bitrate = videoBitrateForTarget(targetBytes, seconds, audioBitrate, recipe.overhead);
    if (bitrate < minVideoBitrate(dims.width, dims.height)) {
        const floor = minTargetBytes(dims.width, dims.height, seconds, audioBitrate, recipe.overhead);
        throw new ConvertFailure(
            'target_too_small',
            `${formatBytes(targetBytes)} ne suffisent pas pour cette durée dans cette définition : le minimum regardable est d’environ ${formatBytes(floor)}. Baisser la définition, raccourcir le passage, ou viser plus gros.`
        );
    }
    // Dans le dossier du travail : par défaut ffmpeg écrit ce journal dans le
    // répertoire courant, et deux travaux se liraient les statistiques l'un de l'autre.
    const twoPass = [
        '-c:v',
        recipe.videoCodec,
        '-b:v',
        String(bitrate),
        ...speed,
        '-passlogfile',
        `${job.paths.work}/pass`
    ];
    return {
        passes: [
            [...input, ...picture, ...twoPass, '-pass', '1', '-an', '-f', 'null', '/dev/null'],
            [...input, ...picture, ...twoPass, '-pass', '2', ...sound, ...tail]
        ],
        seconds
    };
}

export function audioPlan(job: PlanInput): FfmpegPlan {
    const recipe = job.target.recipe;
    if (recipe.engine !== 'audio') throw new Error('Recette audio attendue');
    if (!job.probe.hasAudio) throw new ConvertFailure('unsupported', 'Ce fichier ne contient pas de son.');
    const seconds = keptSeconds(job.probe.durationMs ?? 0, num(job.options, 'trimStart'), num(job.options, 'trimEnd'));
    const rate = str(job.options, 'sampleRate');
    const channels = str(job.options, 'channels');
    return {
        passes: [
            [
                ...inputArgs(job, seconds),
                '-map',
                '0:a:0',
                '-vn',
                '-sn',
                '-dn',
                '-c:a',
                recipe.codec,
                ...(recipe.lossy ? ['-b:a', String((num(job.options, 'bitrate') ?? 192) * 1000)] : []),
                ...(rate && rate !== 'source' ? ['-ar', rate] : []),
                ...(channels && channels !== 'source' ? ['-ac', channels] : []),
                ...(flag(job.options, 'normalize') ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
                '-threads',
                String(env.CONVERT_THREADS),
                ...(recipe.extra ?? []),
                '-f',
                recipe.muxer,
                job.paths.outputPart
            ]
        ],
        seconds
    };
}

export function gifPlan(job: PlanInput): FfmpegPlan {
    const source = requireVideo(job);
    const seconds = keptSeconds(job.probe.durationMs ?? 0, num(job.options, 'trimStart'), num(job.options, 'trimEnd'));
    const crop = cropRect(source, cropOf(job.options, 'crop'));
    const width = Math.min(num(job.options, 'gifWidth') ?? 480, crop?.width ?? source.width);
    const chain = [
        ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
        `fps=${num(job.options, 'gifFps') ?? 12}`,
        `scale=${width}:-2:flags=lanczos`,
        // La palette se calcule sur la vidéo elle-même : celle par défaut donne des aplats sales.
        'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5'
    ].join(',');
    return {
        passes: [
            [
                ...inputArgs(job, seconds),
                '-filter_complex',
                `[0:v:0]${chain}`,
                '-an',
                '-threads',
                String(env.CONVERT_THREADS),
                '-f',
                'gif',
                job.paths.outputPart
            ]
        ],
        seconds
    };
}

/**
 * L'avancement d'une ligne de `-progress`, en millièmes de la durée gardée.
 * Ce flux est un contrat de ffmpeg, à l'inverse de sa sortie d'erreur.
 */
export function progressOf(line: string, seconds: number): number | null {
    const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
    if (!match || seconds <= 0) return null;
    return Math.min(1000, Math.round((Number(match[1]) / 1_000_000 / seconds) * 1000));
}

export async function runFfmpeg(job: EngineJob, plan: FfmpegPlan, maxOutputBytes: number): Promise<void> {
    // Le budget vaut pour le travail entier : la seconde passe n'en reçoit que ce que la première a laissé.
    const deadline = Date.now() + env.CONVERT_JOB_TIMEOUT_SECONDS * 1000;
    for (const [index, args] of plan.passes.entries()) {
        await runTool({
            bin: 'ffmpeg',
            args,
            workDir: job.paths.work,
            signal: job.signal,
            timeoutMs: Math.max(1000, deadline - Date.now()),
            stallMs: env.CONVERT_STALL_SECONDS * 1000,
            watchFile: job.paths.outputPart,
            maxOutputBytes,
            onLine: (line) => {
                const permille = progressOf(line, plan.seconds);
                if (permille !== null) job.onProgress(Math.round((index * 1000 + permille) / plan.passes.length));
            }
        });
    }
}
