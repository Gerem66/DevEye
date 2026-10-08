import { spawn } from 'child_process';
import { createGzip } from 'zlib';

import type { PathExclusion } from '@deveye/types';
import type { DatabaseBackupAccess, MailServerBackupProvider, TreeBackupProvider } from '@deveye/types/sdk';
import type { AgentFolderArchiveSummary, AgentsFacade, SdkLogger } from '@deveye/types/sdk/server';
import { env } from './env';
import { keywordTable, maildirFileName, maildirFolder } from './maildir';
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
    /** Lu une fois le flux épuisé : ce qu'une archive réussie a dû laisser de côté. */
    warning?: () => string | null;
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
        // Fin des options : le nom de la base est saisi par un membre, et sans
        // ce séparateur `--result-file=/chemin` se lirait comme une option (une
        // écriture de fichier arbitraire sous le compte du serveur).
        '--',
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
                              // Par option et non en positionnel : un nom saisi
                              // par un membre ne peut pas se lire comme `--file=…`.
                              `--dbname=${access.database}`
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

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

/** Un nom de dossier racine sûr à l'extraction : ni séparateur, ni `.` ou `..`. */
function rootDir(name: string): string {
    const clean = name.replace(/[\\/]/g, '_').trim();
    return clean === '' || clean === '.' || clean === '..' ? slugify(name) : clean;
}

/**
 * Le contenu d'un fichier, à la taille annoncée par l'en-tête déjà écrit. Un
 * contenu illisible ne doit pas emporter toute l'archive : l'entrée est
 * complétée par des zéros pour que le `tar` reste valide, et c'est dit. Plus
 * long qu'annoncé, il décalerait toutes les entrées suivantes : abandon.
 */
async function* sizedBody(
    open: () => Promise<AsyncIterable<Uint8Array>>,
    size: number,
    label: string,
    onUnreadable: (err: Error) => void
): AsyncGenerator<Buffer> {
    let written = 0;
    try {
        for await (const chunk of await open()) {
            written += chunk.length;
            if (written > size) break;
            yield Buffer.from(chunk);
        }
    } catch (e) {
        onUnreadable(e as Error);
    }
    if (written > size) throw new Error(`« ${label} » est plus long qu’annoncé : archive abandonnée.`);
    if (written < size) yield Buffer.alloc(size - written);
    yield tarPadding(size);
}

/**
 * Les fichiers d'un partage CloudSync ou d'un dossier hébergé, en clair dans
 * un `tar` reconstitué depuis leur index : l'archive doit s'extraire avec
 * `tar -xzf` sans DevEye.
 */
export async function treeSource(
    provider: TreeBackupProvider,
    root: { id: number; name: string },
    logger: SdkLogger
): Promise<BackupArtifact> {
    let unreadable = 0;
    async function* stream(): AsyncGenerator<Buffer> {
        const base = rootDir(root.name);
        const entries = [...(await provider.entries(root.id))];
        // Chemin croissant : l'archive se relit dans l'ordre de l'arborescence,
        // et un `tar -t` reste lisible.
        entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

        for (const entry of entries) {
            const isDir = entry.kind === 'dir';
            yield tarHeader({
                path: `${base}/${entry.relPath}`,
                size: isDir ? 0 : entry.size,
                mtime: entry.mtime,
                mode: entry.mode,
                isDir
            });
            if (isDir) continue;
            yield* sizedBody(
                () => provider.open(root.id, entry.ref),
                entry.size,
                entry.relPath,
                (err) => {
                    unreadable += 1;
                    logger.error(
                        { rootId: root.id, relPath: entry.relPath, err: err.message },
                        'Backup : fichier illisible, entrée complétée par des zéros'
                    );
                }
            );
        }
        yield tarEnd();
    }

    return {
        name: `${slugify(root.name)}-${stamp()}.tar.gz`,
        stream: gzipStream(stream()),
        warning: () =>
            unreadable > 0
                ? `${plural(unreadable, 'fichier illisible complété', 'fichiers illisibles complétés')} par des zéros.`
                : null
    };
}

/** Une page de messages : borne la mémoire, pas le débit. */
const MESSAGE_PAGE = 200;

/**
 * Une adresse du Serveur mail, en Maildir++ : chaque message en clair sous
 * `cur/`, ses drapeaux dans son nom, les mots-clés dans `dovecot-keywords`.
 * Les messages effacés entre la liste et la lecture sont sautés, pas tus.
 */
export async function mailboxSource(
    provider: MailServerBackupProvider,
    mailbox: { id: number; address: string },
    logger: SdkLogger
): Promise<BackupArtifact> {
    const left = { gone: 0, unreadable: 0, renamed: 0, keywords: 0 };

    async function* stream(): AsyncGenerator<Buffer> {
        const root = rootDir(mailbox.address);
        const now = Date.now();
        const dir = (path: string): Buffer => tarHeader({ path, size: 0, mtime: now, mode: 0o700, isDir: true });
        function* file(path: string, content: string): Generator<Buffer> {
            const bytes = Buffer.from(content, 'utf8');
            yield tarHeader({ path, size: bytes.length, mtime: now, mode: 0o600, isDir: false });
            yield bytes;
            yield tarPadding(bytes.length);
        }

        const folders = [...(await provider.folders(mailbox.id))]
            .map((folder) => ({ folder, place: maildirFolder(folder.path) }))
            .sort((a, b) => a.place.dir.localeCompare(b.place.dir));

        yield dir(root);
        const subscribed = folders.filter((f) => f.folder.subscribed).map((f) => `${f.place.name}\n`);
        yield* file(`${root}/subscriptions`, subscribed.join(''));

        for (const { folder, place } of folders) {
            if (place.renamed) left.renamed += 1;
            const base = place.dir === '' ? root : `${root}/${place.dir}`;
            if (place.dir !== '') {
                yield dir(base);
                yield* file(`${base}/maildirfolder`, '');
            }
            for (const sub of ['cur', 'new', 'tmp']) yield dir(`${base}/${sub}`);
            const table = keywordTable(folder.keywords);
            left.keywords += table.dropped;
            if (table.file !== '') yield* file(`${base}/dovecot-keywords`, table.file);

            let after = 0;
            for (;;) {
                const page = await provider.messages(mailbox.id, folder.id, after, MESSAGE_PAGE);
                for (const message of page) {
                    after = message.uid;
                    // Ouvert AVANT l'en-tête : un message effacé entre-temps se saute proprement.
                    const body = await provider.open(mailbox.id, message.id);
                    if (body === null) {
                        left.gone += 1;
                        continue;
                    }
                    yield tarHeader({
                        path: `${base}/cur/${maildirFileName(message, table.letters)}`,
                        size: message.size,
                        mtime: message.internalDate * 1000,
                        mode: 0o600,
                        isDir: false
                    });
                    yield* sizedBody(
                        async () => body,
                        message.size,
                        `message ${message.id}`,
                        (err) => {
                            left.unreadable += 1;
                            logger.error(
                                { mailboxId: mailbox.id, messageId: message.id, err: err.message },
                                'Backup : message illisible, entrée complétée par des zéros'
                            );
                        }
                    );
                }
                if (page.length < MESSAGE_PAGE) break;
            }
        }
        yield tarEnd();
    }

    return {
        name: `${slugify(mailbox.address)}-${stamp()}.tar.gz`,
        stream: gzipStream(stream()),
        warning: () => describeMailboxLeftovers(left)
    };
}

/** Ce qu'une archive de boîte a dû laisser de côté, en une phrase ; `null` si rien. */
export function describeMailboxLeftovers(left: {
    gone: number;
    unreadable: number;
    renamed: number;
    keywords: number;
}): string | null {
    const parts: string[] = [];
    if (left.gone > 0)
        parts.push(plural(left.gone, 'message effacé pendant la sauvegarde', 'messages effacés pendant la sauvegarde'));
    if (left.unreadable > 0) {
        parts.push(
            plural(
                left.unreadable,
                'message illisible complété par des zéros',
                'messages illisibles complétés par des zéros'
            )
        );
    }
    if (left.renamed > 0) {
        parts.push(
            plural(left.renamed, 'dossier dont le point est devenu « _ »', 'dossiers dont le point est devenu « _ »')
        );
    }
    if (left.keywords > 0) {
        parts.push(plural(left.keywords, 'mot-clé au-delà de 26 non gardé', 'mots-clés au-delà de 26 non gardés'));
    }
    return parts.length > 0 ? `${parts.join(', ')}.` : null;
}

/** Ce qu'une archive réussie a dû laisser de côté, en une phrase ; `null` si rien. */
export function describeArchiveSummary(summary: AgentFolderArchiveSummary | null): string | null {
    if (!summary || (summary.skipped === 0 && summary.changed === 0)) return null;
    const parts: string[] = [];
    if (summary.skipped > 0)
        parts.push(plural(summary.skipped, 'élément illisible ignoré', 'éléments illisibles ignorés'));
    if (summary.changed > 0) {
        parts.push(
            plural(summary.changed, 'fichier modifié pendant la lecture', 'fichiers modifiés pendant la lecture')
        );
    }
    const first = summary.samples
        .slice(0, 3)
        .map((s) => `${s.path} (${s.reason})`)
        .join(', ');
    return `${parts.join(', ')}.${first ? ` Premiers : ${first}.` : ''}`;
}

/**
 * Un dossier d'une machine, archivé par son agent au rythme où la destination
 * absorbe : le flux est déjà un `.tar.gz`, il ne se recompresse pas.
 */
export function deviceFolderSource(
    agents: AgentsFacade,
    device: { id: string; name: string },
    folder: { path: string; exclusions: readonly PathExclusion[]; oneFileSystem: boolean },
    signal: AbortSignal
): BackupArtifact {
    const archive = agents.archiveFolder(
        device.id,
        { path: folder.path, exclusions: folder.exclusions, oneFileSystem: folder.oneFileSystem },
        { signal }
    );
    const base = folder.path.split(/[\\/]/).filter(Boolean).pop() ?? 'racine';
    return {
        name: `${slugify(device.name)}-${slugify(base)}-${stamp()}.tar.gz`,
        stream: archive,
        warning: () => describeArchiveSummary(archive.summary)
    };
}
