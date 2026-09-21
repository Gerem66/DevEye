import { spawn } from 'node:child_process';
import os from 'node:os';

import type { ConvertErrorCode } from '../contracts/domain';
import { fileSize } from './storage';

/** Un échec de conversion, avec sa cause au vocabulaire fermé et une phrase à montrer. */
export class ConvertFailure extends Error {
    constructor(
        public readonly code: ConvertErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'ConvertFailure';
    }
}

/** Le travail a été annulé par un membre : ni un échec, ni une erreur à journaliser. */
export class ConvertCanceled extends Error {
    constructor() {
        super('Conversion annulée');
        this.name = 'ConvertCanceled';
    }
}

const STDERR_KEPT = 4000;
const STDOUT_KEPT = 1024 * 1024;
const WATCH_MS = 2000;

export interface RunOptions {
    bin: string;
    args: readonly string[];
    /** Le dossier du travail : répertoire courant, `HOME` et `TMPDIR` de l'outil. */
    workDir: string;
    signal: AbortSignal;
    timeoutMs: number;
    /** Chaque ligne de la sortie standard, au fil de l'eau (l'avancement de ffmpeg). */
    onLine?(line: string): void;
    /** Tué s'il ne dit rien et n'écrit rien pendant ce délai. */
    stallMs?: number;
    /** Le fichier produit : sa croissance vaut avancement, et sa taille est plafonnée. */
    watchFile?: string;
    maxOutputBytes?: number;
    env?: Readonly<Record<string, string>>;
}

/**
 * L'environnement d'un outil : le strict nécessaire, jamais celui du serveur,
 * qui porte les clés de chiffrement et le mot de passe de la base. Un outil
 * tiers qui plante ne doit rien pouvoir en emporter.
 */
function toolEnv(workDir: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: workDir,
        TMPDIR: workDir,
        LANG: 'C.UTF-8',
        ...extra
    };
}

/**
 * Lance un outil de conversion et attend sa fin. Jamais de shell : chaque
 * valeur est un argument à part, rien ne s'interprète.
 */
export async function runTool(opts: RunOptions): Promise<{ stdout: string; stderr: string }> {
    if (opts.signal.aborted) throw new ConvertCanceled();

    const child = spawn(opts.bin, [...opts.args], {
        cwd: opts.workDir,
        env: toolEnv(opts.workDir, opts.env),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    // Une conversion ne doit pas affamer le serveur qui répond aux membres.
    if (child.pid) {
        try {
            os.setPriority(child.pid, 10);
        } catch {
            // Le processus a pu finir entre-temps.
        }
    }

    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let lastActivity = Date.now();
    let lastSize = 0;
    let killedFor: ConvertFailure | ConvertCanceled | null = null;
    const startedAt = Date.now();

    const kill = (reason: ConvertFailure | ConvertCanceled): void => {
        if (killedFor) return;
        killedFor = reason;
        child.kill('SIGKILL');
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        lastActivity = Date.now();
        if (stdout.length < STDOUT_KEPT) stdout += chunk;
        if (!opts.onLine) return;
        const lines = (pendingLine + chunk).split('\n');
        pendingLine = lines.pop() ?? '';
        for (const line of lines) opts.onLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_KEPT);
    });

    const onAbort = (): void => kill(new ConvertCanceled());
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const watch = setInterval(() => {
        void (async () => {
            const now = Date.now();
            if (now - startedAt > opts.timeoutMs) {
                return kill(new ConvertFailure('timeout', 'La conversion a dépassé le temps qui lui est accordé.'));
            }
            if (opts.watchFile) {
                const size = (await fileSize(opts.watchFile)) ?? 0;
                if (size !== lastSize) {
                    lastSize = size;
                    lastActivity = now;
                }
                if (opts.maxOutputBytes && size > opts.maxOutputBytes) {
                    return kill(
                        new ConvertFailure(
                            'output_too_large',
                            'Le fichier produit dépasse la taille permise : choisir un format ou des réglages plus légers.'
                        )
                    );
                }
            }
            if (opts.stallMs && now - lastActivity > opts.stallMs) {
                kill(new ConvertFailure('stalled', 'La conversion n’avançait plus : le fichier est peut-être abîmé.'));
            }
        })();
    }, WATCH_MS);
    watch.unref();

    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        if (killedFor) throw killedFor;
        if (code !== 0) {
            const detail = stderr.trim().split('\n').pop() ?? '';
            throw new ConvertFailure(
                'engine_failed',
                detail ? `La conversion a échoué : ${detail}` : 'La conversion a échoué.'
            );
        }
        return { stdout, stderr };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new ConvertFailure('engine_missing', `« ${opts.bin} » est introuvable sur le serveur.`);
        }
        throw e;
    } finally {
        clearInterval(watch);
        opts.signal.removeEventListener('abort', onAbort);
    }
}

/** Un appel court dont on lit la sortie : une sonde, une version. */
export async function captureTool(
    bin: string,
    args: readonly string[],
    workDir: string,
    timeoutMs: number,
    env?: Readonly<Record<string, string>>
): Promise<string> {
    const { stdout } = await runTool({ bin, args, workDir, timeoutMs, env, signal: new AbortController().signal });
    return stdout;
}
