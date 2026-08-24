import { spawn } from 'child_process';
import { createGzip } from 'zlib';
import type { Logger } from 'pino';

import { env } from '@/Utils/Env';
import { openTunnel, type Tunnel } from '@/Services/databases/tunnel';
import type { EngineTarget } from '@/Services/databases/engine';
import type { CloudSyncBackupProvider } from '@deveye/types/sdk';
import { tarEnd, tarHeader, tarPadding } from './tar';

/**
 * Ce qu'un travail de sauvegarde produit : un nom d'archive et un flux d'octets.
 *
 * Le flux n'est **jamais** matérialisé quelque part avant d'être écrit : il part
 * du producteur (un `mysqldump`, un parcours de blobs) vers la destination en
 * traversant la compression puis, éventuellement, le scellement. Une base de
 * 40 Gio ne coûte donc ni 40 Gio de disque temporaire ni 40 Gio de mémoire.
 *
 * ## Pourquoi `mysqldump` et `pg_dump` plutôt qu'un vidage maison
 *
 * DevEye sait déjà lire une base par ses adaptateurs (`Services/databases/`), et
 * il aurait été tentant d'en tirer le vidage. Ce serait une erreur : un vidage
 * juste doit reproduire les vues, les procédures, les déclencheurs, les
 * séquences, les contraintes différées, les types utilisateur, l'ordre
 * d'insertion imposé par les clés étrangères, et l'échappement exact de chaque
 * dialecte. Ces outils font exactement ça, ils sont testés par des millions
 * d'installations, et surtout **leur sortie se restaure avec `mysql <` ou
 * `psql <`** — sans DevEye. Une sauvegarde qui exige son producteur pour être
 * relue n'est pas une sauvegarde.
 *
 * ⚠️ Ils doivent donc être présents dans l'image (voir `Dockerfile`). Leur
 * absence est signalée par une phrase explicite, jamais par un `ENOENT` nu.
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
 * Lance un outil externe et rend sa sortie standard en flux.
 *
 * La sortie d'erreur est **retenue** (bornée) plutôt que journalisée au fil de
 * l'eau : `mysqldump` y écrit ses avertissements bénins autant que la raison
 * d'un échec, et seule la fin de course dit laquelle des deux on vient de lire.
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

/**
 * `mysqldump` de MariaDB ne connaît pas `--set-gtid-purged`.
 *
 * Le détecter coûte un `--version` (quelques millisecondes, une fois par
 * sauvegarde) et évite le seul mode d'échec qu'on ne peut pas rattraper une fois
 * l'écriture commencée : découvrir l'option inconnue quand le premier octet est
 * déjà parti sur la destination.
 */
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
        // sur un compte applicatif ordinaire — le cas courant.
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
 * Une base supervisée de l'espace, à travers le **même accès** que la
 * supervision — tunnel SSH ou proxy SOCKS compris.
 *
 * Le tunnel est fermé quand le flux s'achève, quelle qu'en soit la raison : un
 * tunnel oublié laisse une session SSH et un écouteur ouverts, et quelques
 * sauvegardes ratées suffiraient à épuiser les descripteurs du processus.
 */
export async function databaseSource(target: EngineTarget, label: string): Promise<BackupArtifact> {
    const maria = target.engine === 'mysql' ? await isMariaDump() : false;

    async function* stream(): AsyncGenerator<Buffer> {
        let tunnel: Tunnel | null = null;
        try {
            tunnel = await openTunnel(target.access, { host: target.host, port: target.port });
            const inner =
                target.engine === 'postgres'
                    ? spawnStream(
                          'pg_dump',
                          [
                              `--host=${tunnel.host}`,
                              `--port=${tunnel.port}`,
                              `--username=${target.username}`,
                              '--no-password',
                              // Format texte : restaurable par `psql <`, sans
                              // `pg_restore` ni version compatible de celui-ci.
                              '--format=plain',
                              // Une restauration sur une base neuve doit recréer
                              // ses propriétaires et ses droits.
                              '--no-owner',
                              '--no-privileges',
                              target.database
                          ],
                          target.password ? { PGPASSWORD: target.password } : {},
                          `la base « ${label} »`
                      )
                    : spawnStream(
                          'mysqldump',
                          mysqlDumpArgs(tunnel.host, tunnel.port, target.username, target.database, maria),
                          target.password ? { MYSQL_PWD: target.password } : {},
                          `la base « ${label} »`
                      );
            for await (const chunk of inner) yield chunk;
        } finally {
            await tunnel?.close().catch(() => {});
        }
    }

    return { name: `${slugify(label)}-${stamp()}.sql.gz`, stream: gzipStream(stream()) };
}

/**
 * Les blobs d'un partage CloudSync, rendus **en clair** dans une archive `tar`.
 *
 * L'index (qui est à quel chemin) vit en base, donc dans la sauvegarde `deveye` ;
 * les blobs, eux, sont la seule partie de DevEye à vivre sur le disque. Les deux
 * ensemble font la restauration complète.
 *
 * L'arborescence est reconstituée telle que l'utilisateur la connaît, et non
 * copiée sous forme de blobs adressés par condensé : une archive doit pouvoir
 * s'extraire avec `tar -xzf` sur une machine où DevEye n'a jamais tourné. C'est
 * la différence entre une sauvegarde et une copie de répertoire technique.
 */
export async function cloudSyncSource(
    provider: CloudSyncBackupProvider,
    share: { id: number; name: string },
    logger: Logger
): Promise<BackupArtifact> {
    async function* stream(): AsyncGenerator<Buffer> {
        // Le module fournit l'index et les blobs déchiffrés ; le flux tar
        // reste ici, côté public, comme pour les autres sources.
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
