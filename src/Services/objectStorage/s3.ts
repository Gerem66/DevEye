import crypto from 'crypto';

import type { Response } from 'undici';

import { safeFetch } from '@/Services/netFetch';

/**
 * Client S3 minimal (déposer, relire, lister, effacer), écrit ici plutôt que
 * d'importer `@aws-sdk/client-s3` et sa centaine de paquets pour quelques
 * requêtes figées : le protocole tient en une signature SigV4. Compatible
 * Garage, MinIO, Scaleway, Backblaze et AWS ; la seule différence qui compte
 * est `pathStyle`. Deux usages : les destinations de sauvegarde qu'un membre
 * saisit, et le stockage objet de l'hôte.
 */

/**
 * Le transport d'une requête signée. Par défaut le garde des appels sortants :
 * une adresse saisie par un membre ne vise jamais le réseau interne. Le
 * stockage de l'hôte passe le sien, l'adresse venant de l'opérateur.
 */
export type S3Fetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal }
) => Promise<Response>;

export interface S3Config {
    /** `https://s3.exemple.fr` — schéma compris, sans chemin. */
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** `https://hôte/bucket/clé` plutôt que `https://bucket.hôte/clé`. */
    pathStyle: boolean;
}

/** Un objet tel que le listage le rend. */
export interface S3Object {
    key: string;
    size: number;
}

/**
 * 16 Mio par partie : au-dessus du minimum S3 (5 Mio), 10 000 parties couvrent
 * 160 Gio, et jamais plus de 16 Mio de clair en mémoire.
 */
export const S3_PART_BYTES = 16 * 1024 * 1024;

/** Le plus grand lot qu'une requête `DeleteObjects` accepte. */
const DELETE_BATCH = 1000;

/** Au-delà, on passe en envoi multiple plutôt qu'en un seul `PUT`. */
const SINGLE_PUT_LIMIT = S3_PART_BYTES;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** Une requête de sauvegarde peut être longue ; une requête pendue, jamais. */
const REQUEST_TIMEOUT_MS = 180_000;

const sha256hex = (data: crypto.BinaryLike): string => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string): Buffer =>
    crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * `encodeURIComponent` plus les cinq caractères qu'il laisse passer et que la
 * signature exige encodés : les oublier casse la signature par intermittence.
 */
function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
    );
}

/** Le chemin d'une clé, segment par segment : les `/` restent des séparateurs. */
function encodeKey(key: string): string {
    return key
        .split('/')
        .map((seg) => uriEncode(seg))
        .join('/');
}

interface SignedRequest {
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
    /** Clé de l'objet, ou `''` pour une opération de bucket. */
    key?: string;
    /** Paramètres de requête, triés et signés. */
    query?: Record<string, string>;
    body?: Buffer;
    headers?: Record<string, string>;
}

export class S3Error extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'S3Error';
    }
}

export class S3Client {
    private readonly host: string;
    private readonly origin: string;
    private readonly basePath: string;

    constructor(
        private readonly config: S3Config,
        private readonly fetcher: S3Fetch = (url, init) => safeFetch(url, init)
    ) {
        let url: URL;
        try {
            url = new URL(config.endpoint);
        } catch {
            throw new Error(`Adresse S3 invalide : « ${config.endpoint} »`);
        }
        if (config.pathStyle) {
            this.host = url.host;
            this.origin = `${url.protocol}//${url.host}`;
            this.basePath = `/${uriEncode(config.bucket)}`;
        } else {
            this.host = `${config.bucket}.${url.host}`;
            this.origin = `${url.protocol}//${this.host}`;
            this.basePath = '';
        }
    }

    /** L'URL complète d'une opération, pour l'affichage et le diagnostic. */
    urlFor(key: string): string {
        return `${this.origin}${this.basePath}/${encodeKey(key)}`;
    }

    private async send(req: SignedRequest): Promise<Response> {
        const body = req.body ?? Buffer.alloc(0);
        const payloadHash = sha256hex(body);
        const now = new Date();
        const amzDate = now
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}/, '');
        const dateStamp = amzDate.slice(0, 8);

        const canonicalUri = req.key ? `${this.basePath}/${encodeKey(req.key)}` : `${this.basePath}/`;
        const query = req.query ?? {};
        const canonicalQuery = Object.keys(query)
            .sort()
            .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
            .join('&');

        const headers: Record<string, string> = {
            host: this.host,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
        };
        const signedNames = Object.keys(headers).sort();
        const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
        const signedHeaders = signedNames.join(';');

        const canonicalRequest = [
            req.method,
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');

        const scope = `${dateStamp}/${this.config.region}/${SERVICE}/aws4_request`;
        const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');

        const signingKey = hmac(
            hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), SERVICE),
            'aws4_request'
        );
        const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

        headers.authorization =
            `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`;

        const url = `${this.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
        const res = await this.fetcher(url, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new S3Error(explainS3(res.status, text), res.status);
        }
        return res;
    }

    /** Dépose un objet en une seule requête. Réservé aux petites archives. */
    async putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
        await this.send({
            method: 'PUT',
            key,
            body,
            headers: { 'content-type': contentType, 'content-length': String(body.length) }
        });
    }

    async deleteObject(key: string): Promise<void> {
        await this.send({ method: 'DELETE', key });
    }

    /** La taille d'un objet, `null` s'il n'existe pas. */
    async headObject(key: string): Promise<{ size: number } | null> {
        try {
            const res = await this.send({ method: 'HEAD', key });
            return { size: Number(res.headers.get('content-length') ?? 0) };
        } catch (e) {
            if (e instanceof S3Error && e.status === 404) return null;
            throw e;
        }
    }

    /** Le contenu d'un objet, en flux. `range` est inclusif, comme l'en-tête HTTP. */
    async *getObject(key: string, range?: { start: number; end?: number }): AsyncGenerator<Buffer> {
        const headers = range ? { range: `bytes=${range.start}-${range.end ?? ''}` } : undefined;
        const res = await this.send({ method: 'GET', key, headers });
        if (!res.body) return;
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield Buffer.from(value);
        }
    }

    /** Les objets sous un préfixe, page par page : un partage peut en compter des dizaines de milliers. */
    async *listObjects(prefix: string): AsyncGenerator<S3Object> {
        let token: string | null = null;
        do {
            const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
            if (token) query['continuation-token'] = token;
            const res = await this.send({ method: 'GET', query });
            const xml = await res.text();
            for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
                const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
                const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
                if (key !== undefined) yield { key: decodeXml(key), size: Number(size ?? 0) };
            }
            token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
                ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
                : null;
            if (token) token = decodeXml(token);
        } while (token);
    }

    /**
     * Efface des objets par lots de mille, le maximum d'une requête. Le service
     * répond 200 même quand une clé échoue : l'échec se lit dans le corps.
     */
    async deleteObjects(keys: readonly string[]): Promise<void> {
        for (let i = 0; i < keys.length; i += DELETE_BATCH) {
            const batch = keys.slice(i, i + DELETE_BATCH);
            const body = Buffer.from(
                '<Delete><Quiet>true</Quiet>' +
                    batch.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('') +
                    '</Delete>',
                'utf8'
            );
            const res = await this.send({
                method: 'POST',
                query: { delete: '' },
                body,
                headers: {
                    'content-type': 'application/xml',
                    'content-length': String(body.length),
                    // Exigé par S3 pour cette seule opération.
                    'content-md5': crypto.createHash('md5').update(body).digest('base64')
                }
            });
            const xml = await res.text();
            if (/<Error>/.test(xml)) throw new S3Error(explainS3(200, xml), 200);
        }
    }

    /** Tout ce qui vit sous un préfixe. */
    async deletePrefix(prefix: string): Promise<void> {
        let batch: string[] = [];
        for await (const object of this.listObjects(prefix)) {
            batch.push(object.key);
            if (batch.length >= DELETE_BATCH) {
                await this.deleteObjects(batch);
                batch = [];
            }
        }
        if (batch.length > 0) await this.deleteObjects(batch);
    }

    /**
     * Écrit un flux vers une clé : un seul `PUT` sous le seuil, envoi multiple
     * au-delà (la taille n'est pas connue à l'avance). En cas d'échec, l'envoi
     * multiple est abandonné explicitement : S3 facture les parties d'un envoi
     * jamais terminé, invisibles au listage.
     */
    async putStream(
        key: string,
        source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
        contentType?: string
    ): Promise<number> {
        const pending: Buffer[] = [];
        let pendingLen = 0;
        let total = 0;
        let uploadId: string | null = null;
        const etags: string[] = [];

        const flushPart = async (): Promise<void> => {
            const part = Buffer.concat(pending, pendingLen);
            pending.length = 0;
            pendingLen = 0;
            etags.push(await this.uploadPart(key, uploadId as string, etags.length + 1, part));
        };

        try {
            for await (const bytes of source) {
                const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
                pending.push(chunk);
                pendingLen += chunk.length;
                total += chunk.length;

                if (pendingLen < SINGLE_PUT_LIMIT) continue;
                if (uploadId === null) uploadId = await this.createMultipart(key, contentType);
                while (pendingLen >= S3_PART_BYTES) {
                    // Une partie fait exactement `S3_PART_BYTES` ; le reliquat
                    // repart dans le tampon. S3 n'accepte des tailles inégales
                    // que sur la **dernière** partie.
                    const joined = Buffer.concat(pending, pendingLen);
                    pending.length = 0;
                    pending.push(joined.subarray(S3_PART_BYTES));
                    pendingLen = pending[0].length;
                    etags.push(
                        await this.uploadPart(key, uploadId, etags.length + 1, joined.subarray(0, S3_PART_BYTES))
                    );
                }
            }

            if (uploadId === null) {
                await this.putObject(key, Buffer.concat(pending, pendingLen), contentType);
                return total;
            }
            if (pendingLen > 0) await flushPart();
            await this.completeMultipart(key, uploadId, etags);
            return total;
        } catch (e) {
            if (uploadId !== null) await this.abortMultipart(key, uploadId).catch(() => {});
            throw e;
        }
    }

    private async createMultipart(key: string, contentType?: string): Promise<string> {
        const res = await this.send({
            method: 'POST',
            key,
            query: { uploads: '' },
            headers: contentType ? { 'content-type': contentType } : undefined
        });
        const xml = await res.text();
        const id = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(xml)?.[1];
        if (!id) throw new Error("S3 : réponse d'ouverture d'envoi multiple illisible.");
        return decodeXml(id);
    }

    private async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
        const res = await this.send({
            method: 'PUT',
            key,
            query: { partNumber: String(partNumber), uploadId },
            body,
            headers: { 'content-length': String(body.length) }
        });
        const etag = res.headers.get('etag');
        if (!etag) throw new Error(`S3 : partie ${partNumber} acceptée sans ETag.`);
        return etag;
    }

    private async completeMultipart(key: string, uploadId: string, etags: string[]): Promise<void> {
        const body = Buffer.from(
            '<CompleteMultipartUpload>' +
                etags
                    .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
                    .join('') +
                '</CompleteMultipartUpload>',
            'utf8'
        );
        const res = await this.send({
            method: 'POST',
            key,
            query: { uploadId },
            body,
            headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }
        });
        // S3 répond 200 puis échoue dans le corps : seul endroit du protocole où
        // 200 ne veut pas dire réussi.
        const xml = await res.text();
        if (/<Error>/.test(xml)) {
            throw new S3Error(explainS3(200, xml), 200);
        }
    }

    private async abortMultipart(key: string, uploadId: string): Promise<void> {
        await this.send({ method: 'DELETE', key, query: { uploadId } });
    }
}

function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Une phrase corrigeable plutôt qu'un code HTTP : chaque erreur se corrige à un endroit différent de l'écran. */
function explainS3(status: number, body: string): string {
    const code = /<Code>([\s\S]*?)<\/Code>/.exec(body)?.[1] ?? '';
    if (code === 'SignatureDoesNotMatch' || status === 403) {
        return 'S3 : accès refusé. Vérifiez la clé d’accès, la clé secrète et les droits sur le bucket.';
    }
    if (code === 'NoSuchBucket') return "S3 : ce bucket n'existe pas sur ce service.";
    if (code === 'InvalidAccessKeyId') return "S3 : cette clé d'accès est inconnue du service.";
    if (code === 'AuthorizationHeaderMalformed' || code === 'InvalidRegion') {
        return 'S3 : la région déclarée ne correspond pas à celle du service.';
    }
    if (status === 404) return 'S3 : introuvable (bucket ou objet). Vérifiez le bucket et le style d’adressage.';
    // Le mot du service, borné : il revient au membre, et l'adresse est de son choix.
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1];
    return `S3 : ${message ? decodeXml(message).slice(0, 200) : `erreur HTTP ${status}`}`;
}
