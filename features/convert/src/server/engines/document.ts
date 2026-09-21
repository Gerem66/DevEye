import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SourceFormat } from '../../contracts/catalogue';
import { num, str } from '../../contracts/options';
import { env } from '../env';
import { captureTool, ConvertFailure, runTool } from '../spawn';
import { fileSize } from '../storage';
import type { EngineJob, InputProbe } from './types';

const PDF_MAGIC = '%PDF-';
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Ce que LibreOffice lit au démarrage du profil jetable d'un travail : macros
 * coupées, liens externes jamais suivis. Un document est une archive qui peut
 * désigner un modèle distant ou embarquer du code.
 */
const OFFICE_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`;

async function startsWith(file: string, magic: string): Promise<boolean> {
    const handle = await fs.open(file, 'r');
    try {
        const buffer = Buffer.alloc(magic.length);
        await handle.read(buffer, 0, magic.length, 0);
        return buffer.toString('latin1') === magic;
    } finally {
        await handle.close();
    }
}

export async function probeDocument(
    source: SourceFormat,
    inputPath: string,
    workDir: string,
    inputBytes: number
): Promise<InputProbe> {
    const probe: InputProbe = {
        bytes: inputBytes,
        durationMs: null,
        width: null,
        height: null,
        fps: null,
        reader: null,
        hasAudio: false,
        pages: null
    };
    if (source.group !== 'pdf') return probe;
    if (!(await startsWith(inputPath, PDF_MAGIC))) {
        throw new ConvertFailure(
            'format_mismatch',
            'Ce fichier n’est pas un PDF : choisir le format d’entrée qui lui correspond.'
        );
    }
    try {
        const info = await captureTool('pdfinfo', [inputPath], workDir, PROBE_TIMEOUT_MS);
        const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
        return { ...probe, pages: Number.isFinite(pages) && pages > 0 ? pages : null };
    } catch (e) {
        // Sans `pdfinfo`, l'allègement reste possible : seul le nombre de pages manque.
        if (e instanceof ConvertFailure && e.code === 'engine_missing') return probe;
        throw new ConvertFailure('corrupt', 'Ce PDF ne se lit pas : il est abîmé, ou protégé par un mot de passe.');
    }
}

/** Ce que l'outil a écrit devient le résultat du travail. Un outil qui sort sans rien produire est un échec. */
async function adopt(produced: string, job: EngineJob): Promise<void> {
    if (!(await fileSize(produced))) {
        throw new ConvertFailure(
            'engine_failed',
            'La conversion n’a rien produit : le document est peut-être abîmé ou protégé.'
        );
    }
    await fs.rename(produced, job.paths.outputPart);
}

const budget = (job: EngineJob, maxOutputBytes: number, watchFile: string) => ({
    workDir: job.paths.work,
    signal: job.signal,
    timeoutMs: env.CONVERT_JOB_TIMEOUT_SECONDS * 1000,
    watchFile,
    maxOutputBytes
});

/**
 * LibreOffice. Le profil est propre au travail : partagé, deux conversions se
 * disputeraient son verrou et la seconde ne ferait rien, sans le dire ; et un
 * document qui y écrit contaminerait les suivants.
 */
async function runOffice(job: EngineJob, filter: string, maxOutputBytes: number): Promise<void> {
    const profile = path.join(job.paths.work, 'lo');
    const outDir = path.join(job.paths.work, 'out');
    await fs.mkdir(path.join(profile, 'user'), { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), OFFICE_PROFILE);

    // LibreOffice choisit son filtre de lecture d'après l'extension : le fichier
    // reçu la retrouve ici, celle du catalogue et jamais celle de l'envoi.
    const named = path.join(job.paths.work, `input.${job.source.ext[0]}`);
    await fs.link(job.paths.input, named).catch(() => fs.copyFile(job.paths.input, named));

    const produced = path.join(outDir, `input.${job.target.ext}`);
    await runTool({
        bin: 'soffice',
        args: [
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            '--headless',
            '--invisible',
            '--norestore',
            '--nolockcheck',
            '--nodefault',
            '--nofirststartwizard',
            '--convert-to',
            filter,
            '--outdir',
            outDir,
            named
        ],
        ...budget(job, maxOutputBytes, produced),
        // Aucun avancement à lire : seule la croissance du fichier dit qu'il travaille encore.
        stallMs: undefined,
        env: { SAL_USE_VCLPLUGIN: 'svp' }
    });
    await adopt(produced, job);
}

async function runPdfImage(job: EngineJob, device: 'png' | 'jpeg', maxOutputBytes: number): Promise<void> {
    const page = Math.min(num(job.options, 'page') ?? 1, job.probe.pages ?? Number.MAX_SAFE_INTEGER);
    const stem = path.join(job.paths.work, 'page');
    const produced = `${stem}.${device === 'png' ? 'png' : 'jpg'}`;
    await runTool({
        bin: 'pdftoppm',
        args: [
            '-f',
            String(page),
            '-l',
            String(page),
            '-r',
            String(num(job.options, 'dpi') ?? 150),
            `-${device}`,
            '-singlefile',
            job.paths.input,
            stem
        ],
        ...budget(job, maxOutputBytes, produced)
    });
    await adopt(produced, job);
}

async function runPdfCompress(job: EngineJob, maxOutputBytes: number): Promise<void> {
    await runTool({
        bin: 'gs',
        args: [
            '-dSAFER',
            '-dBATCH',
            '-dNOPAUSE',
            '-dQUIET',
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.5',
            `-dPDFSETTINGS=/${str(job.options, 'level') ?? 'ebook'}`,
            `-sOutputFile=${job.paths.outputPart}`,
            job.paths.input
        ],
        ...budget(job, maxOutputBytes, job.paths.outputPart)
    });
}

async function runPdfText(job: EngineJob, maxOutputBytes: number): Promise<void> {
    await runTool({
        bin: 'pdftotext',
        args: ['-layout', '-enc', 'UTF-8', job.paths.input, job.paths.outputPart],
        ...budget(job, maxOutputBytes, job.paths.outputPart)
    });
}

export async function runDocument(job: EngineJob, maxOutputBytes: number): Promise<void> {
    const recipe = job.target.recipe;
    switch (recipe.engine) {
        case 'office':
            await runOffice(job, recipe.filter, maxOutputBytes);
            break;
        case 'pdfImage':
            await runPdfImage(job, recipe.device, maxOutputBytes);
            break;
        case 'pdfCompress':
            await runPdfCompress(job, maxOutputBytes);
            break;
        case 'pdfText':
            await runPdfText(job, maxOutputBytes);
            break;
        default:
            throw new Error('Recette de document attendue');
    }
    job.onProgress(1000);
}
