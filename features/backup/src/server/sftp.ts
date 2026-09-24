import crypto from 'crypto';
import net from 'net';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Client, type SFTPWrapper } from 'ssh2';

import type { BackupDestinationProbe, BackupSftpAuth } from '../contracts/domain';

// Le garde des connexions sortantes, partagé par toute l'app : l'hôte SFTP est
// saisi par un membre, et `publicLookup` referme la fenêtre entre la
// vérification et la connexion (rebinding DNS).
import { assertAllowedOutboundHost, publicLookup } from '@/Services/netFetch';
import type { BackupSink } from './sinks';

export interface SftpConfig {
    host: string;
    port: number;
    username: string;
    auth: BackupSftpAuth;
    /** Le mot de passe ou la clé privée, selon `auth`. */
    secret: string;
    /** L'empreinte retenue (`SHA256:…`) ; `null` tant qu'aucun contrôle ne l'a validée. */
    hostKey: string | null;
}

const READY_TIMEOUT_MS = 12_000;
/** Un serveur muet pendant 8 × 15 s est tenu pour mort, envoi en cours compris. */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 8;
/** `SSH_FX_NO_SUCH_FILE`. */
const NO_SUCH_FILE = 2;

/** L'empreinte telle que `ssh-keygen -lf` l'affiche, pour que le membre puisse la comparer. */
export function hostKeyFingerprint(key: Buffer): string {
    return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Les segments d'un dossier, absolu ou relatif au dossier de connexion. */
function folderOf(input: string): string {
    const trimmed = input.trim();
    const absolute = trimmed.startsWith('/');
    const segments = trimmed.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) {
        throw new Error('Le dossier SFTP ne peut pas contenir « . » ni « .. ».');
    }
    return (absolute ? '/' : '') + segments.join('/');
}

function call<T>(run: (done: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => run((err, value) => (err ? reject(err) : resolve(value as T))));
}

function errorCode(e: unknown): unknown {
    return (e as { code?: unknown }).code;
}

/**
 * Un dossier sur un serveur SSH. L'archive est écrite sous `<nom>.part` puis
 * renommée. Rien ne part vers un serveur dont l'empreinte n'a pas été
 * retenue par un contrôle : c'est le premier « Tester » qui la valide.
 */
export class SftpSink implements BackupSink {
    /** L'empreinte vue à la dernière connexion : ce qu'un premier contrôle fait retenir. */
    seenHostKey: string | null = null;
    private readonly folder: string;

    constructor(
        private readonly config: SftpConfig,
        folder: string,
        /** Vrai pour un contrôle seulement : il est le seul à pouvoir faire connaissance. */
        private readonly allowUnknownHost = false
    ) {
        this.folder = folderOf(folder);
    }

    private pathOf(name: string): string {
        if (this.folder === '') return name;
        return this.folder === '/' ? `/${name}` : `${this.folder}/${name}`;
    }

    describe(name: string): string {
        const path = this.pathOf(name);
        return `sftp://${this.config.username}@${this.config.host}:${this.config.port}${path.startsWith('/') ? '' : '/~/'}${path}`;
    }

    private async session<T>(run: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
        if (!this.config.hostKey && !this.allowUnknownHost) {
            throw new Error('L’empreinte de ce serveur SFTP n’a pas encore été validée : testez la destination.');
        }
        await assertAllowedOutboundHost(this.config.host);

        const client = new Client();
        let mismatch: string | null = null;
        const ready = new Promise<void>((resolve, reject) => {
            client.once('ready', resolve);
            // Permanent : une erreur de la connexion en plein envoi, sans écouteur,
            // ferait tomber le processus. Après `ready`, l'opération en cours échoue
            // d'elle-même par son propre rappel.
            client.on('error', (e) =>
                reject(
                    mismatch
                        ? new Error(
                              `L’empreinte du serveur a changé (${mismatch}, attendue ${this.config.hostKey}). ` +
                                  'Si le serveur a été réinstallé, oubliez l’empreinte dans la destination puis testez-la.'
                          )
                        : e
                )
            );
        });
        client.connect({
            sock: net.connect({ host: this.config.host, port: this.config.port, lookup: publicLookup }),
            username: this.config.username,
            ...(this.config.auth === 'key' ? { privateKey: this.config.secret } : { password: this.config.secret }),
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: KEEPALIVE_INTERVAL_MS,
            keepaliveCountMax: KEEPALIVE_COUNT_MAX,
            hostVerifier: (key: Buffer) => {
                const seen = hostKeyFingerprint(key);
                this.seenHostKey = seen;
                if (!this.config.hostKey) return this.allowUnknownHost;
                if (seen === this.config.hostKey) return true;
                mismatch = seen;
                return false;
            }
        });
        try {
            await ready;
            const sftp = await call<SFTPWrapper>((done) => client.sftp(done));
            return await run(sftp);
        } finally {
            client.end();
        }
    }

    /** Crée le dossier et ses parents ; un dossier déjà là n'est pas une erreur. */
    private async ensureFolder(sftp: SFTPWrapper): Promise<void> {
        if (this.folder === '' || this.folder === '/') return;
        const absolute = this.folder.startsWith('/');
        const segments = this.folder.split('/').filter((s) => s.length > 0);
        for (let depth = 1; depth <= segments.length; depth += 1) {
            const dir = (absolute ? '/' : '') + segments.slice(0, depth).join('/');
            const exists = await call<{ isDirectory(): boolean }>((done) => sftp.stat(dir, done)).then(
                (stats) => stats.isDirectory(),
                () => false
            );
            if (exists) continue;
            await call<void>((done) => sftp.mkdir(dir, done));
        }
    }

    /** Remplace la cible si elle existe : l'extension OpenSSH le fait d'un coup, sinon effacer puis renommer. */
    private async renameOver(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
        try {
            await call<void>((done) => sftp.ext_openssh_rename(from, to, done));
            return;
        } catch (e) {
            // Sans l'extension, ssh2 lève avant d'envoyer quoi que ce soit.
            if (!(e instanceof Error) || !/does not support/.test(e.message)) throw e;
        }
        await this.unlinkQuietly(sftp, to);
        await call<void>((done) => sftp.rename(from, to, done));
    }

    private async unlinkQuietly(sftp: SFTPWrapper, path: string): Promise<void> {
        try {
            await call<void>((done) => sftp.unlink(path, done));
        } catch (e) {
            if (errorCode(e) !== NO_SUCH_FILE) throw e;
        }
    }

    async write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }> {
        const tmp = this.pathOf(`${name}.part`);
        const final = this.pathOf(name);
        let size = 0;
        async function* counted(): AsyncGenerator<Buffer> {
            for await (const chunk of source) {
                size += chunk.length;
                yield chunk;
            }
        }
        await this.session(async (sftp) => {
            await this.ensureFolder(sftp);
            try {
                await pipeline(Readable.from(counted()), sftp.createWriteStream(tmp));
                await this.renameOver(sftp, tmp, final);
            } catch (e) {
                await this.unlinkQuietly(sftp, tmp).catch(() => undefined);
                throw e;
            }
        });
        return { artifact: final, size };
    }

    async remove(artifact: string): Promise<void> {
        // Une archive d'un autre dossier n'est pas la nôtre à effacer.
        if (artifact !== this.pathOf(artifact.slice(artifact.lastIndexOf('/') + 1))) {
            throw new Error('Archive hors du dossier de cette destination.');
        }
        await this.session((sftp) => this.unlinkQuietly(sftp, artifact));
    }

    async probe(): Promise<BackupDestinationProbe> {
        try {
            return await this.session(async (sftp) => {
                await this.ensureFolder(sftp);
                // Écrire, relire, effacer : lister ne prouve pas qu'on peut écrire.
                const witness = this.pathOf(`.deveye-write-test-${crypto.randomBytes(6).toString('hex')}`);
                await pipeline(Readable.from([Buffer.from('deveye')]), sftp.createWriteStream(witness));
                const stats = await call<{ size: number }>((done) => sftp.stat(witness, done));
                await this.unlinkQuietly(sftp, witness);
                if (stats.size !== 6) throw new Error("Le fichier témoin n'a pas été relu à l'identique.");

                const dir = this.folder === '' ? '.' : this.folder;
                const entries = await call<{ attrs: { size: number; isFile(): boolean } }[]>((done) =>
                    sftp.readdir(dir, done)
                );
                const usedBytes = entries.filter((e) => e.attrs.isFile()).reduce((sum, e) => sum + e.attrs.size, 0);
                return { ok: true, error: null, usedBytes, freeBytes: await this.freeBytes(sftp, dir) };
            });
        } catch (e) {
            return { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }
    }

    /** L'extension OpenSSH quand le serveur l'offre ; sinon on ne sait pas. */
    private async freeBytes(sftp: SFTPWrapper, dir: string): Promise<number | null> {
        try {
            const info = await call<{ f_bavail: number | bigint; f_frsize: number | bigint }>((done) =>
                sftp.ext_openssh_statvfs(dir, done)
            );
            const free = Number(info.f_bavail) * Number(info.f_frsize);
            return Number.isSafeInteger(free) ? free : null;
        } catch {
            return null;
        }
    }
}
