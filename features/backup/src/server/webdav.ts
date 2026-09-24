import crypto from 'crypto';

import type { BackupDestinationProbe } from '../contracts/domain';

// Le garde des appels sortants, partagé par toute l'app : l'adresse du serveur
// WebDAV est saisie par un membre, et chaque requête porte son mot de passe.
import { safeFetch } from '@/Services/netFetch';
import type { BackupSink } from './sinks';

export interface WebDavConfig {
    /** L'URL de base (`https://cloud.exemple.fr/remote.php/dav/files/moi`). */
    url: string;
    username: string;
    password: string;
}

/** Délai d'une requête sans corps à envoyer : MKCOL, MOVE, DELETE, PROPFIND. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Un envoi qui ne fait plus passer un octet pendant ce temps est tenu pour mort. */
const IDLE_TIMEOUT_MS = 120_000;
/** Une fois le corps parti, le temps laissé au serveur pour ranger le fichier et répondre. */
const FINAL_TIMEOUT_MS = 10 * 60_000;

/** Les segments d'un dossier relatif, refusés s'ils sortent de l'URL de base. */
function folderSegments(folder: string): string[] {
    const segments = folder
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) {
        throw new Error('Le dossier WebDAV ne peut pas contenir « . » ni « .. ».');
    }
    return segments;
}

/** L'URL d'un dossier, terminée par `/` : c'est la forme qu'attend WebDAV pour une collection. */
function collectionUrl(base: string, segments: readonly string[]): URL {
    const root = new URL(base);
    if (!root.pathname.endsWith('/')) root.pathname += '/';
    root.pathname += segments.map((s) => `${encodeURIComponent(s)}/`).join('');
    return root;
}

/** Un résumé de la réponse d'erreur, pour une phrase que le membre peut suivre. */
async function failure(res: Response, what: string): Promise<Error> {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (res.status === 401 || res.status === 403) {
        return new Error(`${what} : accès refusé (${res.status}). Vérifiez l’identifiant et le mot de passe.`);
    }
    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        return new Error(`${what} : le serveur redirige${location ? ` vers ${location}` : ''}. Corrigez l’adresse.`);
    }
    return new Error(`${what} : réponse ${res.status}${body ? ` (${body})` : ''}.`);
}

/**
 * Un dossier WebDAV : Nextcloud, Synology, kDrive. L'archive part en flux
 * (`PUT` sans longueur connue) vers `<nom>.part`, puis `MOVE` vers son nom :
 * un envoi coupé ne laisse jamais un fichier qui a l'air complet.
 */
export class WebDavSink implements BackupSink {
    private readonly folder: URL;
    private readonly segments: string[];
    private readonly auth: string;

    constructor(
        private readonly config: WebDavConfig,
        folder: string
    ) {
        this.segments = folderSegments(folder);
        this.folder = collectionUrl(config.url, this.segments);
        this.auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    }

    private fileUrl(name: string): URL {
        return new URL(encodeURIComponent(name), this.folder);
    }

    /**
     * Sans suivre de redirection : un corps en flux ne se rejoue pas, et une
     * adresse qui redirige est une adresse à corriger.
     */
    private request(url: URL, method: string, init: { headers?: Record<string, string>; body?: string } = {}) {
        return safeFetch(url, {
            method,
            headers: { authorization: this.auth, ...init.headers },
            body: init.body,
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    }

    describe(name: string): string {
        return this.fileUrl(name).toString();
    }

    /** Crée le dossier et ses parents ; 405 dit qu'il existe déjà. */
    private async ensureFolder(): Promise<void> {
        for (let depth = 1; depth <= this.segments.length; depth += 1) {
            const url = collectionUrl(this.config.url, this.segments.slice(0, depth));
            const res = await this.request(url, 'MKCOL');
            await res.body?.cancel();
            if (res.ok || res.status === 405) continue;
            throw await failure(res, `Création du dossier ${url.pathname}`);
        }
    }

    /** Envoie un flux ; rend le nombre d'octets partis. */
    private async put(url: URL, source: AsyncIterable<Buffer>): Promise<number> {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | null = null;
        const arm = (ms: number, reason: string): void => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => abort.abort(new Error(reason)), ms);
            timer.unref();
        };
        let size = 0;
        async function* counted(): AsyncGenerator<Buffer> {
            for await (const chunk of source) {
                arm(IDLE_TIMEOUT_MS, 'L’envoi WebDAV est resté bloqué deux minutes.');
                size += chunk.length;
                yield chunk;
            }
            arm(FINAL_TIMEOUT_MS, 'Le serveur WebDAV n’a pas confirmé l’envoi.');
        }

        arm(IDLE_TIMEOUT_MS, 'L’envoi WebDAV n’a pas démarré.');
        try {
            const res = await safeFetch(url, {
                method: 'PUT',
                headers: { authorization: this.auth, 'content-type': 'application/octet-stream' },
                body: counted(),
                // Exigé par fetch pour un corps en flux.
                duplex: 'half',
                redirect: 'manual',
                signal: abort.signal
            });
            if (!res.ok) throw await failure(res, 'Envoi');
            await res.body?.cancel();
            return size;
        } catch (e) {
            throw abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async delete(url: URL): Promise<void> {
        const res = await this.request(url, 'DELETE');
        await res.body?.cancel();
        if (!res.ok && res.status !== 404) throw await failure(res, 'Suppression');
    }

    async write(name: string, source: AsyncIterable<Buffer>): Promise<{ artifact: string; size: number }> {
        await this.ensureFolder();
        const tmp = this.fileUrl(`${name}.part`);
        const final = this.fileUrl(name);
        try {
            const size = await this.put(tmp, source);
            const res = await this.request(tmp, 'MOVE', {
                headers: { destination: final.toString(), overwrite: 'T' }
            });
            await res.body?.cancel();
            if (!res.ok) throw await failure(res, 'Renommage de l’archive');
            return { artifact: final.toString(), size };
        } catch (e) {
            await this.delete(tmp).catch(() => undefined);
            throw e;
        }
    }

    async remove(artifact: string): Promise<void> {
        const url = new URL(artifact);
        // Une archive d'un autre dossier n'est pas la nôtre à effacer.
        if (!url.toString().startsWith(this.folder.toString())) {
            throw new Error('Archive hors du dossier de cette destination.');
        }
        await this.delete(url);
    }

    async probe(): Promise<BackupDestinationProbe> {
        try {
            await this.ensureFolder();
            // Le témoin part par le même envoi en flux qu'une archive : un
            // serveur qui le refuse échoue ici, pas à 3 h du matin.
            const witness = this.fileUrl(`.deveye-write-test-${crypto.randomBytes(6).toString('hex')}`);
            await this.put(
                witness,
                (async function* () {
                    yield Buffer.from('deveye');
                })()
            );
            const read = await this.request(witness, 'GET');
            if (!read.ok) throw await failure(read, 'Relecture du témoin');
            const readBack = Buffer.from(await read.arrayBuffer()).toString('utf8');
            await this.delete(witness);
            if (readBack !== 'deveye') throw new Error("Le fichier témoin n'a pas été relu à l'identique.");

            const quota = await this.quota();
            return { ok: true, error: null, ...quota };
        } catch (e) {
            return { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }
    }

    /** RFC 4331, quand le serveur la connaît ; une valeur négative (Nextcloud : « illimité ») ne dit rien. */
    private async quota(): Promise<{ usedBytes: number | null; freeBytes: number | null }> {
        const res = await this.request(this.folder, 'PROPFIND', {
            headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
            body:
                '<?xml version="1.0" encoding="utf-8"?>' +
                '<d:propfind xmlns:d="DAV:"><d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>'
        });
        if (res.status !== 207) {
            await res.body?.cancel();
            return { usedBytes: null, freeBytes: null };
        }
        const xml = await res.text();
        const read = (prop: string): number | null => {
            const match = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${prop}[^>]*>\\s*(-?\\d+)\\s*<`).exec(xml);
            if (!match) return null;
            const value = Number(match[1]);
            return Number.isSafeInteger(value) && value >= 0 ? value : null;
        };
        return { usedBytes: read('quota-used-bytes'), freeBytes: read('quota-available-bytes') };
    }
}
