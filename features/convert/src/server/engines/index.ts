import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SdkLogger } from '@deveye/types/sdk/server';

import { CATALOGUE, type ConvertKind, type Recipe, type SourceFormat } from '../../contracts/catalogue';
import type { ConvertFamily } from '../../contracts/domain';
import { env } from '../env';
import { captureTool } from '../spawn';
import type { JobPaths } from '../storage';
import { probeDocument, runDocument } from './document';
import { audioPlan, gifPlan, probeMedia, runFfmpeg, videoPlan } from './ffmpeg';
import { imageCoders, probeImage, runImage, setImageBinary } from './image';
import type { EngineJob, InputProbe } from './types';

type Tool = 'ffmpeg' | 'magick' | 'soffice' | 'pdftoppm' | 'gs' | 'pdftotext';

const TOOL_OF: Record<Recipe['engine'], Tool> = {
    video: 'ffmpeg',
    gif: 'ffmpeg',
    audio: 'ffmpeg',
    image: 'magick',
    office: 'soffice',
    pdfImage: 'pdftoppm',
    pdfCompress: 'gs',
    pdfText: 'pdftotext'
};

/** Ce que chaque outil apporte, pour la phrase qui dit lequel manque. */
const TOOL_PURPOSE: Record<Tool, string> = {
    ffmpeg: 'convertir les vidéos et les fichiers audio',
    magick: 'convertir les images (ImageMagick)',
    soffice: 'convertir les documents bureautiques (LibreOffice)',
    pdftoppm: 'tirer une image d’un PDF (poppler-utils)',
    gs: 'alléger un PDF (Ghostscript)',
    pdftotext: 'tirer le texte d’un PDF (poppler-utils)'
};

const PROBE_TIMEOUT_MS = 30_000;
const MIN_OUTPUT_CEILING = 512 * 1024 ** 2;

const UNKNOWN: readonly ConvertFamily[] = CATALOGUE.map((k) => ({
    kind: k.id,
    available: false,
    reason: 'Vérification des outils de conversion en cours.',
    missingSources: [],
    missingTargets: []
}));

let families: readonly ConvertFamily[] = UNKNOWN;
export const engineFamilies = (): readonly ConvertFamily[] => families;

async function responds(bin: string, args: readonly string[], workDir: string): Promise<boolean> {
    try {
        await captureTool(bin, args, workDir, PROBE_TIMEOUT_MS);
        return true;
    } catch {
        return false;
    }
}

/**
 * Sonde les outils une fois, au démarrage. Aucune absence n'empêche le module
 * de démarrer : elle retire des formats de l'écran, avec le nom de ce qui manque.
 */
export async function probeEngines(storageProblem: string | null, logger: SdkLogger): Promise<void> {
    if (storageProblem) {
        families = CATALOGUE.map((k) => ({
            kind: k.id,
            available: false,
            reason: storageProblem,
            missingSources: [],
            missingTargets: []
        }));
        logger.warn({ reason: storageProblem }, 'convert: stockage indisponible, aucune conversion de fichier');
        return;
    }

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'deveye-convert-probe-'));
    try {
        const present = new Set<Tool>();
        if ((await responds('ffmpeg', ['-version'], scratch)) && (await responds('ffprobe', ['-version'], scratch))) {
            present.add('ffmpeg');
        }
        if (await responds('magick', ['-version'], scratch)) present.add('magick');
        else if (await responds('convert', ['-version'], scratch)) {
            setImageBinary('convert');
            present.add('magick');
        }
        // Un profil jetable : sans lui la sonde en crée un dans le `HOME`, que les travaux se disputeraient.
        const profile = pathToFileURL(path.join(scratch, 'lo')).href;
        if (await responds('soffice', [`-env:UserInstallation=${profile}`, '--headless', '--version'], scratch)) {
            present.add('soffice');
        }
        for (const tool of ['pdftoppm', 'pdftotext'] as const) {
            if (await responds(tool, ['-v'], scratch)) present.add(tool);
        }
        if (await responds('gs', ['--version'], scratch)) present.add('gs');

        const coders = present.has('magick') ? await imageCoders(scratch).catch(() => null) : null;
        families = CATALOGUE.map((kind) => {
            const missingTargets = kind.targets
                .filter((t) => {
                    if (!present.has(TOOL_OF[t.recipe.engine])) return true;
                    return t.recipe.engine === 'image' && coders !== null && !coders.write.has(t.recipe.coder);
                })
                .map((t) => t.id);
            const missingSources = kind.sources
                .filter((s) => {
                    if (kind.id === 'image' && coders && !coders.read.has(s.readers?.[0] ?? '')) return true;
                    return !kind.targets.some((t) => t.from.includes(s.group) && !missingTargets.includes(t.id));
                })
                .map((s) => s.id);
            const available = missingSources.length < kind.sources.length;
            const absent = [...new Set(kind.targets.map((t) => TOOL_OF[t.recipe.engine]))].filter(
                (t) => !present.has(t)
            );
            const reason =
                available || absent.length === 0
                    ? null
                    : `« ${absent[0]} » est introuvable sur le serveur. Cet outil est nécessaire pour ${TOOL_PURPOSE[absent[0]]}.`;
            if (absent.length > 0) logger.warn({ kind: kind.id, absent }, 'convert: outils de conversion absents');
            return { kind: kind.id, available, reason, missingSources, missingTargets };
        });
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

/** La vérité sur le fichier reçu. Lève une `ConvertFailure` quand il n'est pas ce qu'il annonce. */
export function probeInput(
    kind: ConvertKind,
    source: SourceFormat,
    paths: JobPaths,
    inputBytes: number
): Promise<InputProbe> {
    switch (kind) {
        case 'video':
        case 'audio':
            return probeMedia(source, paths.input, paths.work, inputBytes);
        case 'image':
            return probeImage(source, paths.input, paths.work, inputBytes);
        case 'document':
            return probeDocument(source, paths.input, paths.work, inputBytes);
    }
}

/** Mène la conversion jusqu'à `out.part`. Le plafond de sortie suit le fichier d'entrée, avec un plancher. */
export async function convert(job: EngineJob): Promise<void> {
    const maxOutputBytes = Math.min(
        env.CONVERT_MAX_OUTPUT_BYTES,
        Math.max(job.probe.bytes * env.CONVERT_OUTPUT_RATIO_MAX, MIN_OUTPUT_CEILING)
    );
    switch (job.target.recipe.engine) {
        case 'video':
            return runFfmpeg(job, videoPlan(job), maxOutputBytes);
        case 'audio':
            return runFfmpeg(job, audioPlan(job), maxOutputBytes);
        case 'gif':
            return runFfmpeg(job, gifPlan(job), maxOutputBytes);
        case 'image':
            return runImage(job, maxOutputBytes);
        case 'office':
        case 'pdfImage':
        case 'pdfCompress':
        case 'pdfText':
            return runDocument(job, maxOutputBytes);
    }
}
