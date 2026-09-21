import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SdkLogger } from '@deveye/types/sdk/server';

import { env } from './env';

/**
 * Le disque du module. Aucun chemin ne contient autre chose que des entiers :
 * le nom d'un fichier envoyé ne touche jamais le système de fichiers.
 *
 *   <racine>/ws-<espace>/<travail>/in.part   le fichier en cours de réception
 *                                  in.bin    le fichier reçu en entier
 *                                  out.part  le résultat en cours d'écriture
 *                                  out.bin   le résultat
 *                                  work/     le seul endroit où un outil écrit
 */

const root = (): string => path.resolve(env.CONVERT_STORAGE_DIR);

export interface JobPaths {
    dir: string;
    inputPart: string;
    input: string;
    outputPart: string;
    output: string;
    work: string;
}

export function jobPaths(workspaceId: number, jobId: number): JobPaths {
    if (!Number.isSafeInteger(workspaceId) || !Number.isSafeInteger(jobId) || workspaceId <= 0 || jobId <= 0) {
        throw new Error('Identifiant de travail invalide');
    }
    const dir = path.resolve(root(), `ws-${workspaceId}`, String(jobId));
    // Vraie par construction aujourd'hui : elle le reste le jour où le chemin change.
    if (!dir.startsWith(`${root()}${path.sep}`)) throw new Error('Chemin hors du stockage');
    return {
        dir,
        inputPart: path.join(dir, 'in.part'),
        input: path.join(dir, 'in.bin'),
        outputPart: path.join(dir, 'out.part'),
        output: path.join(dir, 'out.bin'),
        work: path.join(dir, 'work')
    };
}

export async function ensureJobDir(paths: JobPaths): Promise<void> {
    await fs.mkdir(paths.work, { recursive: true });
}

/** Idempotent : retirer un dossier déjà parti n'est pas une erreur. */
export async function removeJobDir(workspaceId: number, jobId: number): Promise<void> {
    await fs.rm(jobPaths(workspaceId, jobId).dir, { recursive: true, force: true });
}

/** La racine existe et s'écrit. Sinon une phrase qui nomme la variable à régler. */
export async function probeStorage(): Promise<string | null> {
    try {
        await fs.mkdir(root(), { recursive: true });
        const witness = path.join(root(), '.write-test');
        await fs.writeFile(witness, '');
        await fs.rm(witness, { force: true });
        return null;
    } catch {
        return `Le dossier de travail « ${root()} » n’est pas accessible en écriture : régler CONVERT_STORAGE_DIR.`;
    }
}

/** Les octets libres sur le disque du stockage, pour qui n'est pas administrateur. */
export async function freeBytes(): Promise<number> {
    const stats = await fs.statfs(root());
    return stats.bavail * stats.bsize;
}

export async function fileSize(file: string): Promise<number | null> {
    try {
        return (await fs.stat(file)).size;
    } catch {
        return null;
    }
}

/**
 * Retire du disque tout dossier qu'aucun travail vivant ne réclame. Un arrêt
 * brutal du serveur ne repasse par aucun `finally` : c'est ici, au démarrage
 * puis à chaque entretien, que ses restes disparaissent.
 */
export async function sweepStorage(keep: ReadonlySet<string>, logger: SdkLogger): Promise<number> {
    let removed = 0;
    let spaces: string[];
    try {
        spaces = await fs.readdir(root());
    } catch {
        return 0;
    }
    for (const space of spaces) {
        const match = /^ws-(\d+)$/.exec(space);
        if (!match) continue;
        const spaceDir = path.join(root(), space);
        for (const job of await fs.readdir(spaceDir)) {
            if (keep.has(`${match[1]}/${job}`)) continue;
            await fs.rm(path.join(spaceDir, job), { recursive: true, force: true });
            removed++;
        }
        if ((await fs.readdir(spaceDir)).length === 0) await fs.rmdir(spaceDir).catch(() => undefined);
    }
    if (removed > 0) logger.info({ removed }, 'convert: dossiers orphelins retirés');
    return removed;
}
