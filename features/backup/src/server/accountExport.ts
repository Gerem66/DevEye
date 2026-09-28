import path from 'node:path';

import {
    openSealedStream,
    type FeatureAccountExport,
    type SdkObjectStore,
    type SdkWorkspaceExportContext
} from '@deveye/types/sdk/server';

import { backupKey } from './crypto';
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
 * archives gardées sur le serveur, ouvertes. `hosted` : le magasin des
 * destinations `local` ; aucune clé lue en base n'est suivie hors de
 * l'espace exporté (`ws-<id>/`).
 */
export function createAccountExport(hosted: () => SdkObjectStore): FeatureAccountExport<BackupRepo> {
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
            const store = hosted();
            const root = `ws-${ctx.workspace.id}/`;
            const key = backupKey(ctx.keys);
            let unreadable = 0;
            for (const row of rows) {
                if (ctx.signal.aborted) return;
                if (!exportable(row)) continue;
                const artifact = await artifactOf(ctx, row.content);
                if (
                    artifact === null ||
                    !artifact.startsWith(root) ||
                    artifact.split('/').includes('..') ||
                    (await store.head(artifact)) === null
                ) {
                    unreadable++;
                    continue;
                }
                const sealed = Number(row.encrypted) === 1;
                const name = sealed
                    ? path.posix.basename(artifact).replace(/\.enc$/, '')
                    : path.posix.basename(artifact);
                const source = store.get(artifact);
                try {
                    await ctx.out.file(`Archives/${name}`, sealed ? openSealedStream(key, source) : source, {
                        mtime: row.finished_at === null ? undefined : Number(row.finished_at),
                        compress: false
                    });
                } catch (e) {
                    if (ctx.signal.aborted) throw e;
                    unreadable++;
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
