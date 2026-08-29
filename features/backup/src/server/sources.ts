import { spawn } from 'child_process';
import { createGzip } from 'zlib';

import type { CloudSyncBackupProvider, DatabaseBackupAccess } from '@deveye/types/sdk';
import type { SdkLogger } from '@deveye/types/sdk/server';
import { env } from './env';
import { tarEnd, tarHeader, tarPadding } from './tar';

/**
 * Ce qu'un travail produit : un nom d'archive et un flux, jamais matérialisé
 * avant d'être écrit. `mysqldump` et `pg_dump` plutôt qu'un vidage maison :
 * leur sortie se restaure avec `mysql <` ou `psql <`, sans DevEye. Ils doivent
 * être présents dans l'image (voir `Dockerfile`).
 */

export interface BackupArtifact {
    /** Nom de fichier, sans chemin. Porte déjà l'extension. */
    name: string;
    /** Le contenu, en flux. */
    stream: AsyncIterable<Buffer>;
}

/** Horodatage de nom d'archive : triable à l'œil comme au `ls`. */
export function stamp(at: Date = new Date()): string {
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return (
        `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
        `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
    );
}

/** Un nom de fichier sûr, tiré d'un intitulé saisi par l'utilisateur. */
export function slugify(input: string): string {
    const slug = input
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug === '' ? 'sauvegarde' : slug;
}

/** Compresse un flux. Niveau 6 : le compromis par défaut de zlib, et le bon ici. */
export async function* gzipStream(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    const gzip = createGzip({ level: 6 });
    const queue: Buffer[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let failure: Error | null = null;

    const wake = (): void => {
        const fn = notify;
        notify = null;
        fn?.();
    };
    gzip.on('data', (chunk: Buffer) => {
        queue.push(chunk);
        wake();
    });
    gzip.on('end', () => {
        done = true;
        wake();
    });
    gzip.on('error', (e: Error) => {
        failure = e;
        done = true;
        wake();
    });

    const pump = (async () => {
        try {
            for await (const chunk of source) {
                if (!gzip.write(chunk)) {
                    await new Promise<void>((resolve) => gzip.once('drain', resolve));
                }
            }
            gzip.end();
        } catch (e) {
            gzip.destroy(e as Error);
        }
    })();

    try {
        for (;;) {
            while (queue.length > 0) {
                const chunk = queue.shift();
                if (chunk) yield chunk;
            }
            if (failure) throw failure;
            if (done) break;
            await new Promise<void>((resolve) => {
                notify = resolve;
            });
        }
    } finally {
        await pump.catch(() => {});
    }
}

/**
 * Lance un outil externe, sortie standard en flux. La sortie d'erreur est
 * retenue (bornée) : seule la fin de course dit si c'était un avertissement
 * bénin ou la cause d'un échec.
 */
async function* spawnStream(
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    label: string
): AsyncGenerator<Buffer> {
    const child = spawn(command, args, {
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });

    const finished = new Promise<void>((resolve, reject) => {
        child.on('error', (e: NodeJS.ErrnoException) => {
            reject(
                e.code === 'ENOENT'
                    ? new Error(
                          `« ${command} » est introuvable sur le serveur. ` +
                              `Cet outil est nécessaire pour sauvegarder ${label}.`
                      )
                    : e
            );
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} a échoué (code ${code ?? -1}) : ${stderr.trim() || 'sans message'}`));
        });
    });

    try {
        for await (const chunk of child.stdout) yield chunk as Buffer;
        await finished;
    } catch (e) {
        child.kill('SIGKILL');
        // On attend malgré tout la fin de course : sans ça, `mysqldump` pourrait
        // remonter son propre échec après qu'on ait rendu la main, et l'erreur
        // partirait dans le vide en `unhandledRejection`.
        await finished.catch(() => {});
        throw e;
    }
}

/** `mysqldump` de MariaDB ne connaît pas `--set-gtid-purged` : le détecter avant que le premier octet parte. */
async function isMariaDump(): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn('mysqldump', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (c: Buffer) => {
            out += c.toString('utf8');
        });
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(/mariadb/i.test(out)));
    });
}

function mysqlDumpArgs(host: string, port: number, user: string, database: string, maria: boolean): string[] {
    return [
        `--host=${host}`,
        `--port=${port}`,
        `--user=${user}`,
        // Cohérence sans verrou de table : la sauvegarde ne doit pas figer la
        // production le temps qu'elle dure.
        '--single-transaction',
        // Ligne à ligne plutôt que tout en mémoire côté client. Sans lui, une
        // grosse table fait grossir le processus `mysqldump` jusqu'à l'OOM.
        '--quick',
        '--routines',
        '--triggers',
        '--events',
        // Sans droit `PROCESS`, l'absence de ce drapeau fait échouer le vidage
        // sur un compte applicatif ordinaire.
        '--no-tablespaces',
        ...(maria ? [] : ['--set-gtid-purged=OFF']),
        database
    ];
}

/** La base de DevEye elle-même. Couvre tout ce qui vit en base : c'est le socle. */
export async function deveyeSource(): Promise<BackupArtifact> {
    const maria = await isMariaDump();
    const args = mysqlDumpArgs(env.DB_HOSTNAME, env.DB_PORT, env.DB_USERNAME, env.DB_DATABASE, maria);
    return {
        name: `deveye-${env.DB_DATABASE}-${stamp()}.sql.gz`,
        // Le mot de passe passe par l'environnement, jamais par `argv` : la
        // ligne de commande d'un processus est lisible par tout le système.
        stream: gzipStream(spawnStream('mysqldump', args, { MYSQL_PWD: env.DB_PASSWORD }, 'la base de DevEye'))
    };
}

/**
 * Une base supervisée, par le même accès que la supervision (tunnel compris),
 * ouvert par Bases de données. Refermé quand le flux s'achève, quelle qu'en
 * soit la raison : un tunnel oublié épuise les descripteurs du processus.
 */
export async function databaseSource(access: DatabaseBackupAccess, label: string): Promise<BackupArtifact> {
    const maria = access.engine === 'mysql' ? await isMariaDump() : false;

    async function* stream(): AsyncGenerator<Buffer> {
        try {
            const inner =
                access.engine === 'postgres'
                    ? spawnStream(
                          'pg_dump',
                          [
                              `--host=${access.host}`,
                              `--port=${access.port}`,
                              `--username=${access.username}`,
                              '--no-password',
                              // Format texte : restaurable par `psql <`, sans
                              // `pg_restore` ni version compatible de celui-ci.
                              '--format=plain',
                              // Une restauration sur une base neuve doit recréer
                              // ses propriétaires et ses droits.
                              '--no-owner',
                              '--no-privileges',
                              access.database
                          ],
                          access.password ? { PGPASSWORD: access.password } : {},
                          `la base « ${label} »`
                      )
                    : spawnStream(
                          'mysqldump',
                          mysqlDumpArgs(access.host, access.port, access.username, access.database, maria),
                          access.password ? { MYSQL_PWD: access.password } : {},
                          `la base « ${label} »`
                      );
            for await (const chunk of inner) yield chunk;
        } finally {
            await access.close().catch(() => {});
        }
    }

    return { name: `${slugify(label)}-${stamp()}.sql.gz`, stream: gzipStream(stream()) };
}

/**
 * Les blobs d'un partage, en clair dans un `tar` reconstitué depuis l'index :
 * l'archive doit s'extraire avec `tar -xzf` sans DevEye.
 */
export async function cloudSyncSource(
    provider: CloudSyncBackupProvider,
    share: { id: number; name: string },
    logger: SdkLogger
): Promise<BackupArtifact> {
    async function* stream(): AsyncGenerator<Buffer> {
        const files = [...(await provider.listPresentFiles(share.id))];
        // Chemin croissant : l'archive se relit dans l'ordre de l'arborescence,
        // et un `tar -t` reste lisible.
        files.sort((a, b) => a.relPath.localeCompare(b.relPath));

        for (const file of files) {
            const isDir = file.kind === 'dir';
            yield tarHeader({
                path: `${share.name}/${file.relPath}`,
                size: isDir ? 0 : file.size,
                mtime: file.mtime,
                mode: file.mode,
                isDir
            });
            if (isDir) continue;

            let written = 0;
            try {
                for await (const chunk of await provider.openBlob(share.id, file.hash)) {
                    written += chunk.length;
                    yield Buffer.from(chunk);
                }
            } catch (e) {
                // Un blob manquant ou corrompu ne doit pas emporter toute
                // l'archive : on complète l'entrée par des zéros pour que le
                // `tar` reste structurellement valide, et on le signale fort.
                logger.error(
                    { shareId: share.id, relPath: file.relPath, err: (e as Error).message },
                    'Backup CloudSync: blob illisible, entrée complétée par des zéros'
                );
            }
            if (written < file.size) yield Buffer.alloc(file.size - written);
            else if (written > file.size) {
                throw new Error(`Blob plus long que l'index pour « ${file.relPath} » : archive abandonnée.`);
            }
            yield tarPadding(file.size);
        }
        yield tarEnd();
    }

    return { name: `${slugify(share.name)}-${stamp()}.tar.gz`, stream: gzipStream(stream()) };
}
