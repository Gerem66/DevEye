import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import type { BackupDestinationProbe } from '../contracts/domain';

import type { AgentsFacade } from '@deveye/types/sdk/server';
import { env } from './env';
import { S3Client, type S3Config } from './s3';

/**
 * Écrire une archive quelque part. Trois règles non négociables : jamais
 * l'archive entière en mémoire ; une écriture ratée ne laisse pas de
 * demi-archive présentable (temporaire puis renommage, ou envoi multiple
 * abandonné) ; `remove()` est idempotent, la rétention repasse.
 */
export interface BackupSink {
    /** Où l'archive va atterrir, en une ligne lisible pour l'écran. */
    describe(name: string): string;
    /** Écrit le flux et rend l'identifiant qui permettra de le retrouver. */
    write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }>;
    /** Efface une archive. Ne lève pas si elle n'est plus là. */
    remove(artifact: string): Promise<void>;
    /** Contrôle d'accessibilité **en écriture**, ici et maintenant. */
    probe(): Promise<BackupDestinationProbe>;
}

/** Ce qu'une destination `local` ou `device` accepte comme sous-dossier. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Refuse `..`, les segments vides et le non-alphanumérique : ce champ finit
 * interpolé dans un chemin de fichier du serveur.
 */
export function safeRelPath(input: string): string {
    const segments = input
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (const seg of segments) {
        if (!SAFE_SEGMENT.test(seg) || seg === '.' || seg === '..') {
            throw new Error(`Dossier invalide : « ${seg} ». Lettres, chiffres, « . », « _ » et « - » seulement.`);
        }
    }
    return segments.join('/');
}

/** Un dossier du serveur sous `BACKUP_STORAGE_DIR`, cloisonné par espace (`ws-<id>/`). */
export class LocalSink implements BackupSink {
    private readonly dir: string;

    constructor(workspaceId: number, relPath: string) {
        const root = path.resolve(env.BACKUP_STORAGE_DIR, `ws-${workspaceId}`);
        const rel = safeRelPath(relPath);
        const dir = rel === '' ? root : path.resolve(root, rel);
        // `safeRelPath` refuse déjà `..` ; le confinement reste vrai si cette
        // règle s'assouplit un jour.
        if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
            throw new Error('Dossier de sauvegarde hors de la racine autorisée.');
        }
        this.dir = dir;
    }

    describe(name: string): string {
        return path.join(this.dir, name);
    }

    async write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }> {
        await fs.mkdir(this.dir, { recursive: true });
        const finalPath = path.join(this.dir, name);
        // Temporaire puis renommage : un `rename` dans le même dossier est
        // atomique, donc le nom définitif n'existe jamais à moitié écrit.
        const tmpPath = `${finalPath}.part`;
        let size = 0;
        try {
            await pipeline(
                Readable.from(
                    (async function* () {
                        for await (const chunk of source) {
                            size += chunk.length;
                            yield chunk;
                        }
                    })()
                ),
                createWriteStream(tmpPath)
            );
            await fs.rename(tmpPath, finalPath);
        } catch (e) {
            await fs.rm(tmpPath, { force: true }).catch(() => {});
            throw e;
        }
        return { artifact: finalPath, size };
    }

    async remove(artifact: string): Promise<void> {
        // Le chemin vient de la base : il n'est supprimé que s'il est bien dans
        // ce dépôt, quoi qu'une ligne ancienne ou altérée prétende.
        const resolved = path.resolve(artifact);
        if (!resolved.startsWith(this.dir + path.sep)) {
            throw new Error('Archive hors du dossier de destination : suppression refusée');
        }
        await fs.rm(resolved, { force: true });
    }

    async probe(): Promise<BackupDestinationProbe> {
        try {
            await fs.mkdir(this.dir, { recursive: true });
            const witness = path.join(this.dir, `.deveye-write-test-${crypto.randomBytes(6).toString('hex')}`);
            await fs.writeFile(witness, 'deveye');
            await fs.rm(witness, { force: true });

            const [used, free] = await Promise.all([this.dirSize(), this.freeBytes()]);
            return { ok: true, error: null, usedBytes: used, freeBytes: free };
        } catch (e) {
            return { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }
    }

    private async dirSize(): Promise<number> {
        let total = 0;
        const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const stat = await fs.stat(path.join(this.dir, entry.name)).catch(() => null);
            if (stat) total += stat.size;
        }
        return total;
    }

    private async freeBytes(): Promise<number | null> {
        try {
            const fsStat = await fs.statfs(this.dir);
            return Number(fsStat.bavail) * Number(fsStat.bsize);
        } catch {
            return null;
        }
    }
}

/**
 * Un dossier d'une machine enrôlée, écrit par son agent avec `files.upload` :
 * aucune modification de l'agent, un changement de protocole imposant de
 * recompiler huit cibles. Contre-pression : on attend que le tampon d'envoi
 * redescende, sinon la mémoire du serveur suivrait la taille de l'archive.
 */
export class DeviceSink implements BackupSink {
    /**
     * 512 Kio de clair par trame, soit ~683 Kio en base64 : sous la borne de
     * 1,4 Mio du schéma `files.upload`, avec de la marge pour l'enveloppe JSON.
     */
    private static readonly CHUNK_BYTES = 512 * 1024;
    /** Au-delà, on laisse la socket respirer avant d'en remettre. */
    private static readonly BACKPRESSURE_BYTES = 8 * 1024 * 1024;
    /** Un agent muet sur un ordre court (mkdir, rename, delete) dans ce délai est perdu. */
    private static readonly OP_TIMEOUT_MS = 120_000;
    /**
     * Le verdict d'un dépôt couvre tout le transfert : l'agent ne répond qu'à
     * la trame finale. Même budget que l'exécution d'une sauvegarde.
     */
    private static readonly TRANSFER_TIMEOUT_MS = env.BACKUP_RUN_TIMEOUT_SECONDS * 1000;

    private readonly dir: string;

    constructor(
        /** La façade agents du SDK : les mêmes ordres que l'explorateur de fichiers. */
        private readonly hub: AgentsFacade,
        private readonly deviceId: string,
        private readonly deviceName: string,
        absolutePath: string
    ) {
        const trimmed = absolutePath.trim().replace(/\/+$/, '');
        if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
            throw new Error('Le dossier de la machine doit être un chemin absolu.');
        }
        if (trimmed.includes('..')) throw new Error('Le dossier de la machine ne peut pas contenir « .. ».');
        this.dir = trimmed;
    }

    describe(name: string): string {
        return `${this.deviceName}:${this.dir}/${name}`;
    }

    private opId(): string {
        return `bk-${crypto.randomBytes(9).toString('hex')}`;
    }

    private assertOnline(): void {
        if (!this.hub.isOnline(this.deviceId)) {
            throw new Error(`L'appareil « ${this.deviceName} » est hors ligne.`);
        }
    }

    private async runOp(send: (opId: string) => boolean): Promise<void> {
        const opId = this.opId();
        const waiter = this.hub.awaitFilesOp(opId, DeviceSink.OP_TIMEOUT_MS);
        if (!send(opId)) {
            this.hub.cancelFilesOp(opId);
            throw new Error(`L'appareil « ${this.deviceName} » est hors ligne.`);
        }
        const result = await waiter;
        if (!result.ok) throw new Error(result.error ?? 'Opération refusée par l’agent.');
    }

    async write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }> {
        this.assertOnline();
        // `mkdir` de l'agent est un `create_dir_all` : idempotent, donc appelable
        // à chaque sauvegarde sans se demander si le dossier existe déjà.
        await this.runOp((opId) =>
            this.hub.requestFilesMutate(this.deviceId, { opId, op: 'mkdir', path: this.dir, dest: undefined })
        );

        // Nom temporaire puis renommage, comme en local : une archive coupée en
        // route ne doit pas porter le nom d'une archive complète.
        const tmp = `${this.dir}/${name}.part`;
        const finalPath = `${this.dir}/${name}`;
        const opId = this.opId();
        let offset = 0;
        let pending: Buffer[] = [];
        let pendingLen = 0;

        /** Envoie une trame. Un seul chemin, pour que l'ordre des offsets le reste. */
        const sendFrame = async (frame: Buffer, done: boolean): Promise<void> => {
            await this.waitForDrain();
            const sent = this.hub.requestFilesUpload(this.deviceId, {
                opId,
                path: tmp,
                offset,
                data: frame.toString('base64'),
                done
            });
            if (!sent) throw new Error(`L'appareil « ${this.deviceName} » s'est déconnecté pendant l'envoi.`);
            offset += frame.length;
        };

        // La promesse est armée AVANT la première trame : l'agent ne répond
        // qu'au dernier morceau — ou au premier échec — et une réponse arrivée
        // avant qu'on écoute serait perdue.
        const verdict = this.hub.awaitFilesOp(opId, DeviceSink.TRANSFER_TIMEOUT_MS);
        try {
            for await (const chunk of source) {
                pending.push(chunk);
                pendingLen += chunk.length;
                while (pendingLen >= DeviceSink.CHUNK_BYTES) {
                    const joined = Buffer.concat(pending, pendingLen);
                    pending = [joined.subarray(DeviceSink.CHUNK_BYTES)];
                    pendingLen = pending[0].length;
                    await sendFrame(joined.subarray(0, DeviceSink.CHUNK_BYTES), false);
                }
            }
            // Toujours une dernière trame, même vide : c'est elle qui porte
            // `done`, donc elle seule déclenche le verdict de l'agent.
            await sendFrame(Buffer.concat(pending, pendingLen), true);
        } catch (e) {
            this.hub.cancelFilesOp(opId);
            await this.removeQuietly(tmp);
            throw e;
        }

        const result = await verdict;
        if (!result.ok) {
            await this.removeQuietly(tmp);
            throw new Error(result.error ?? "L'agent n'a pas pu écrire l'archive.");
        }

        await this.runOp((id) =>
            this.hub.requestFilesMutate(this.deviceId, { opId: id, op: 'rename', path: tmp, dest: finalPath })
        );
        return { artifact: finalPath, size: offset };
    }

    async remove(artifact: string): Promise<void> {
        if (!this.hub.isOnline(this.deviceId)) {
            // La rétention repassera : la ligne reste marquée présente, et
            // l'archive sera effacée au prochain passage où l'appareil répond.
            throw new Error(`L'appareil « ${this.deviceName} » est hors ligne.`);
        }
        await this.runOp((opId) =>
            this.hub.requestFilesMutate(this.deviceId, { opId, op: 'delete', path: artifact, dest: undefined })
        );
    }

    private async removeQuietly(target: string): Promise<void> {
        try {
            await this.runOp((opId) =>
                this.hub.requestFilesMutate(this.deviceId, { opId, op: 'delete', path: target, dest: undefined })
            );
        } catch {
            // Un partiel oublié (`.part`) est écrasé au prochain passage ; le
            // masquer derrière l'erreur d'origine serait pire.
        }
    }

    /**
     * Échéance des ordres courts, pas du transfert : deux minutes sans qu'un
     * octet parte, c'est une socket morte.
     */
    private async waitForDrain(): Promise<void> {
        let waited = 0;
        while (this.hub.buffered(this.deviceId) > DeviceSink.BACKPRESSURE_BYTES) {
            if (waited > DeviceSink.OP_TIMEOUT_MS) {
                throw new Error(`L'appareil « ${this.deviceName} » ne consomme plus les données envoyées.`);
            }
            await new Promise((r) => setTimeout(r, 50));
            waited += 50;
        }
    }

    async probe(): Promise<BackupDestinationProbe> {
        try {
            this.assertOnline();
            const witness = `${this.dir}/.deveye-write-test`;
            await this.runOp((opId) =>
                this.hub.requestFilesMutate(this.deviceId, { opId, op: 'mkdir', path: this.dir, dest: undefined })
            );
            const opId = this.opId();
            const verdict = this.hub.awaitFilesOp(opId, DeviceSink.OP_TIMEOUT_MS);
            if (
                !this.hub.requestFilesUpload(this.deviceId, {
                    opId,
                    path: witness,
                    offset: 0,
                    data: Buffer.from('deveye').toString('base64'),
                    done: true
                })
            ) {
                this.hub.cancelFilesOp(opId);
                throw new Error(`L'appareil « ${this.deviceName} » est hors ligne.`);
            }
            const result = await verdict;
            if (!result.ok) throw new Error(result.error ?? "L'agent n'a pas pu écrire dans ce dossier.");
            await this.removeQuietly(witness);
            // L'agent ne rend ni occupation ni espace libre par un ordre de
            // fichier ; Monitoring les donne déjà.
            return { ok: true, error: null, usedBytes: null, freeBytes: null };
        } catch (e) {
            return { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }
    }
}

/** Un bucket S3 : Garage, MinIO, Scaleway, Backblaze, AWS. */
export class S3Sink implements BackupSink {
    private readonly client: S3Client;
    private readonly prefix: string;

    constructor(config: S3Config, prefix: string) {
        this.client = new S3Client(config);
        const clean = prefix.trim().replace(/^\/+|\/+$/g, '');
        if (clean.includes('..')) throw new Error('Le préfixe S3 ne peut pas contenir « .. ».');
        this.prefix = clean;
    }

    private keyFor(name: string): string {
        return this.prefix === '' ? name : `${this.prefix}/${name}`;
    }

    describe(name: string): string {
        return this.client.urlFor(this.keyFor(name));
    }

    async write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }> {
        const key = this.keyFor(name);
        // Pas de temporaire : un objet S3 n'existe qu'une fois l'envoi terminé,
        // le protocole offre l'atomicité du renommage.
        const size = await this.client.putStream(key, source);
        return { artifact: key, size };
    }

    async remove(artifact: string): Promise<void> {
        // S3 rend 204 même pour une clé absente : idempotent par construction.
        await this.client.deleteObject(artifact);
    }

    async probe(): Promise<BackupDestinationProbe> {
        try {
            const key = this.keyFor(`.deveye-write-test-${crypto.randomBytes(6).toString('hex')}`);
            // Écrire, relire, effacer. Lister ne prouve rien : un droit de
            // lecture seule passe le listage et échoue à 3 h du matin.
            await this.client.putObject(key, Buffer.from('deveye'), 'text/plain');
            let readBack = 0;
            for await (const chunk of this.client.getObject(key)) readBack += chunk.length;
            await this.client.deleteObject(key);
            if (readBack !== 6) throw new Error("L'objet témoin n'a pas été relu à l'identique.");

            const objects = await this.client.listObjects(this.prefix);
            const used = objects.reduce((sum, o) => sum + o.size, 0);
            // S3 ne dit rien de l'espace restant : la notion n'existe pas côté
            // protocole, et un quota de bucket ne se lit pas par cette API.
            return { ok: true, error: null, usedBytes: used, freeBytes: null };
        } catch (e) {
            return { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }
    }
}
