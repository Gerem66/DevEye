import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { SdkObjectStore, SdkStoredObject } from '@deveye/types/sdk/server';

import { assertObjectKey, SPOOL_DIR } from './keys';

/** Un fichier en cours d'écriture : jamais listé, jamais lu comme un objet. */
const PART_SUFFIX = '.deveye-part';

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Le point de montage qui porte ce chemin : le montage le plus profond qui le
 * préfixe, sur des frontières de segment (`/data/cloudsync-old` n'est pas dans
 * `/data/cloudsync`).
 */
export function mountPointFor(resolved: string, points: readonly string[]): string {
    let best = '';
    for (const point of points) {
        const inside = resolved === point || resolved.startsWith(point === '/' ? '/' : `${point}/`);
        if (inside && point.length > best.length) best = point;
    }
    return best === '' ? '/' : best;
}

/**
 * Le chemin est-il sur la couche d'écriture d'un conteneur ? Hors volume monté,
 * un dossier y vit, invisible depuis l'hôte et effacé au redéploiement. Hors
 * conteneur, ou sans `/proc` pour en juger, rien n'est refusé.
 */
async function isEphemeralContainerPath(resolved: string): Promise<boolean> {
    const containerized = await fs
        .access('/.dockerenv')
        .then(() => true)
        .catch(() => false);
    if (!containerized) return false;
    let mountinfo: string;
    try {
        mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
    } catch {
        return false;
    }
    // Format : id parent maj:min racine POINT_DE_MONTAGE options...
    const points = mountinfo
        .split('\n')
        .map((line) => line.split(' ')[4])
        .filter((point): point is string => point !== undefined && point.startsWith('/'));
    return mountPointFor(resolved, points) === '/';
}

/**
 * Le magasin sur le disque du serveur : une clé est un chemin sous `root`.
 * Chaque écriture passe par un fichier voisin puis un `rename`, atomique sur
 * un même système de fichiers : un lecteur voit l'objet entier ou rien.
 */
export function localObjectStore(root: string): SdkObjectStore {
    const base = path.resolve(root);
    // Les montages ne changent pas sous un processus : jugé une fois.
    let ephemeral: Promise<string | null> | null = null;

    const resolve = (key: string): string => {
        assertObjectKey(key);
        const full = path.resolve(base, key);
        if (!full.startsWith(base + path.sep)) throw new Error(`Clé hors du magasin : « ${key} »`);
        return full;
    };

    const partFor = (full: string): string => `${full}.${crypto.randomBytes(6).toString('hex')}${PART_SUFFIX}`;

    async function install(full: string, write: (tmp: string) => Promise<void>): Promise<{ size: number }> {
        await fs.mkdir(path.dirname(full), { recursive: true });
        const tmp = partFor(full);
        try {
            await write(tmp);
            await fs.rename(tmp, full);
        } catch (e) {
            await fs.rm(tmp, { force: true });
            throw e;
        }
        return { size: (await fs.stat(full)).size };
    }

    async function* walk(dir: string): AsyncGenerator<SdkStoredObject> {
        let entries: import('node:fs').Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
            if (isMissing(e)) return;
            throw e;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (dir === base && entry.name === SPOOL_DIR) continue;
                yield* walk(full);
            } else if (entry.isFile() && !entry.name.endsWith(PART_SUFFIX)) {
                const size = (await fs.stat(full).catch(() => null))?.size;
                if (size === undefined) continue;
                yield { key: path.relative(base, full).split(path.sep).join('/'), size };
            }
        }
    }

    return {
        kind: 'local',
        describe: () => 'disque du serveur',
        async put(key, body) {
            return install(resolve(key), async (tmp) => {
                if (body instanceof Uint8Array) await fs.writeFile(tmp, body, { flag: 'wx' });
                else await pipeline(Readable.from(body), createWriteStream(tmp, { flags: 'wx' }));
            });
        },
        async putFile(key, localPath) {
            const full = resolve(key);
            await fs.mkdir(path.dirname(full), { recursive: true });
            try {
                await fs.rename(localPath, full);
            } catch (e) {
                // Le spool sur un autre volume que le magasin : copie, puis ménage.
                if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
                await install(full, (tmp) => fs.copyFile(localPath, tmp));
                await fs.rm(localPath, { force: true });
            }
            return { size: (await fs.stat(full)).size };
        },
        async *get(key, range) {
            const stream = createReadStream(resolve(key), range ? { start: range.start, end: range.end } : {});
            for await (const chunk of stream) yield chunk as Buffer;
        },
        async head(key) {
            try {
                const stat = await fs.stat(resolve(key));
                return stat.isFile() ? { size: stat.size } : null;
            } catch (e) {
                if (isMissing(e)) return null;
                throw e;
            }
        },
        async *list(prefix) {
            const cut = prefix.lastIndexOf('/');
            const dir = cut < 0 ? base : resolve(prefix.slice(0, cut));
            for await (const object of walk(dir)) {
                if (object.key.startsWith(prefix)) yield object;
            }
        },
        async delete(key) {
            await fs.rm(resolve(key), { force: true });
        },
        async deletePrefix(prefix) {
            if (!prefix.endsWith('/')) throw new Error(`Préfixe sans « / » final : « ${prefix} »`);
            await fs.rm(resolve(prefix.slice(0, -1)), { recursive: true, force: true });
        },
        spoolDir: () => path.join(base, SPOOL_DIR),
        ephemeralRoot() {
            ephemeral ??= isEphemeralContainerPath(base).then((yes) => (yes ? base : null));
            return ephemeral;
        }
    };
}
