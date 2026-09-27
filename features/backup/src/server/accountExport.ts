import fs from 'node:fs';
import path from 'node:path';

import type { FeatureAccountExport, SdkWorkspaceExportContext } from '@deveye/types/sdk/server';

import { backupKey, openSealedStream } from './crypto';
import type { BackupRepo, LocalArchiveRow } from './repo';
import type { StoredRun } from './_shared';

/**
 * Une archive de la base de DevEye porte les données de tous les comptes et
 * les clés du serveur : elle ne sort pas dans l'export d'un seul compte.
 */
const exportable = (row: LocalArchiveRow): boolean => row.source_kind !== 'deveye';

async function artifactOf(ctx: SdkWorkspaceExportContext<BackupRepo>, content: string): Promise<string | null> {
    const plain = await ctx.open(content);
    if (plain === null) return null;
    try {
        return (JSON.parse(plain) as Partial<StoredRun>).artifact ?? null;
    } catch {
        return null;
    }
}

/**
 * Les destinations sans leur secret, les travaux, leurs exécutions, et les
 * archives gardées sur le disque du serveur, ouvertes. `storageDir` : la
 * racine des destinations `local`, hors de laquelle aucun chemin lu en base
 * n'est suivi.
 */
export function createAccountExport(storageDir: string): FeatureAccountExport<BackupRepo> {
    return {
        tables: {
            backup_destinations: {
                file: 'destinations.json',
                where: 'workspace_id = ?',
                key: ['id'],
                sealed: ['content'],
                json: ['content'],
                dates: { checked_at: 's', created: 's' },
                omit: ['secret_enc']
            },
            backup_jobs: {
                file: 'travaux.json',
                where: 'workspace_id = ?',
                key: ['id'],
                sealed: ['content'],
                json: ['content'],
                dates: { next_run_at: 's', created: 's' }
            },
            backup_runs: {
                file: 'executions.json',
                where: 'job_id IN (SELECT id FROM backup_jobs WHERE workspace_id = ?)',
                key: ['id'],
                sealed: ['content'],
                json: ['content'],
                dates: { started_at: 's', finished_at: 's' }
            }
        },
        files: {
            archives: {
                label: 'les archives de sauvegarde',
                async bytes({ repo, workspaceIds }) {
                    let total = 0;
                    for (const workspaceId of workspaceIds) {
                        for (const row of await repo.listLocalArchives(workspaceId)) {
                            if (exportable(row)) total += Number(row.size_bytes);
                        }
                    }
                    return total;
                }
            }
        },
        async workspace(ctx) {
            if (!ctx.includes('archives')) return;
            const rows = await ctx.repo.listLocalArchives(ctx.workspace.id);
            const root = path.resolve(storageDir, `ws-${ctx.workspace.id}`);
            const key = backupKey(ctx.keys);
            let unreadable = 0;
            for (const row of rows) {
                if (ctx.signal.aborted) return;
                if (!exportable(row)) continue;
                const artifact = await artifactOf(ctx, row.content);
                const file = artifact === null ? null : path.resolve(artifact);
                if (file === null || !file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
                    unreadable++;
                    continue;
                }
                const sealed = Number(row.encrypted) === 1;
                const name = sealed ? path.basename(file).replace(/\.enc$/, '') : path.basename(file);
                const stream = fs.createReadStream(file);
                const source = stream as AsyncIterable<Buffer>;
                try {
                    await ctx.out.file(`Archives/${name}`, sealed ? openSealedStream(key, source) : source, {
                        mtime: row.finished_at === null ? undefined : Number(row.finished_at),
                        compress: false
                    });
                } catch (e) {
                    if (ctx.signal.aborted) throw e;
                    unreadable++;
                } finally {
                    stream.destroy();
                }
            }
            if (rows.some((row) => !exportable(row))) {
                await ctx.out.file(
                    'Archives/LISEZMOI.txt',
                    Buffer.from(
                        'Les archives de la base de DevEye ne sont pas exportées : elles portent les données de tous les comptes du serveur.\n'
                    )
                );
            }
            if (unreadable > 0)
                throw new Error(`${unreadable} archive(s) de sauvegarde illisible(s) ou introuvable(s)`);
        }
    };
}
