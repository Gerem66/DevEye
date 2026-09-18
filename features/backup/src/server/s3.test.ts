import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

// Le faux service S3 écoute sur la boucle locale, que le garde des appels
// sortants refuse par défaut.
import { setAllowPrivateForTest } from '@/Services/netFetch';
import { S3Client, S3_PART_BYTES } from './s3';

before(() => setAllowPrivateForTest(true));
after(() => setAllowPrivateForTest(false));

/**
 * Un dépôt S3 dit 200 même quand l'objet est faux : ordre et taille des parties
 * (inégale seulement sur la dernière). Faux service local, flux de tailles
 * choisies autour du seuil de bascule.
 */

interface FakeS3 {
    server: Server;
    port: number;
    /** Objets complets, par clé. */
    objects: Map<string, Buffer>;
    /** Combien d'envois multiples ont été ouverts. */
    multipartCount: number;
    /** Tailles des parties reçues, dans l'ordre des numéros. */
    partSizes: number[];
    close(): Promise<void>;
}

async function startFakeS3(): Promise<FakeS3> {
    const objects = new Map<string, Buffer>();
    const uploads = new Map<string, Map<number, Buffer>>();
    const state = { multipartCount: 0, partSizes: [] as number[] };

    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const url = new URL(req.url ?? '/', 'http://localhost');
            // Le faux service est en `pathStyle` : /<bucket>/<clé>.
            const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\/?/, ''));

            // Toute requête doit être signée : c'est l'invariant le moins cher à
            // vérifier et le plus coûteux à rater.
            assert.ok(req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '), 'requête non signée');
            assert.ok(req.headers['x-amz-content-sha256'], 'condensé de charge utile absent');

            if (req.method === 'POST' && url.searchParams.has('uploads')) {
                state.multipartCount += 1;
                const id = `upload-${state.multipartCount}`;
                uploads.set(id, new Map());
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
                return;
            }

            const uploadId = url.searchParams.get('uploadId');
            if (req.method === 'PUT' && uploadId) {
                const part = Number(url.searchParams.get('partNumber'));
                uploads.get(uploadId)?.set(part, body);
                res.writeHead(200, { etag: `"part-${part}"` });
                res.end();
                return;
            }

            if (req.method === 'POST' && uploadId) {
                const parts = uploads.get(uploadId);
                assert.ok(parts, 'envoi multiple inconnu');
                const numbers = [...parts.keys()].sort((a, b) => a - b);
                // L'ordre déclaré doit être 1..N sans trou : c'est ce que S3
                // exige, et un trou passerait inaperçu jusqu'à la restauration.
                assert.deepEqual(
                    numbers,
                    numbers.map((_, i) => i + 1),
                    'numéros de parties non contigus'
                );
                state.partSizes = numbers.map((n) => parts.get(n)!.length);
                objects.set(key, Buffer.concat(numbers.map((n) => parts.get(n)!)));
                uploads.delete(uploadId);
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
                return;
            }

            if (req.method === 'PUT') {
                objects.set(key, body);
                res.writeHead(200, { etag: '"single"' });
                res.end();
                return;
            }

            if (req.method === 'DELETE') {
                objects.delete(key);
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
                const prefix = url.searchParams.get('prefix') ?? '';
                const contents = [...objects.entries()]
                    .filter(([k]) => k.startsWith(prefix))
                    .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
                    .join('');
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
                return;
            }

            if (req.method === 'GET') {
                const stored = objects.get(key);
                if (!stored) {
                    res.writeHead(404, { 'content-type': 'application/xml' });
                    res.end('<Error><Code>NoSuchKey</Code><Message>absent</Message></Error>');
                    return;
                }
                res.writeHead(200);
                res.end(stored);
                return;
            }

            res.writeHead(400);
            res.end();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
        server,
        port,
        objects,
        get multipartCount() {
            return state.multipartCount;
        },
        get partSizes() {
            return state.partSizes;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

function clientFor(port: number): S3Client {
    return new S3Client({
        endpoint: `http://127.0.0.1:${port}`,
        region: 'garage',
        bucket: 'sauvegardes',
        accessKeyId: 'CLE',
        secretAccessKey: 'SECRET',
        pathStyle: true
    });
}

async function* chunked(data: Buffer, size: number): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < data.length; offset += size) {
        yield data.subarray(offset, Math.min(offset + size, data.length));
    }
}

describe('dépôt S3', () => {
    it('écrit une petite archive en une seule requête', async () => {
        const s3 = await startFakeS3();
        try {
            const data = crypto.randomBytes(64 * 1024);
            const written = await clientFor(s3.port).putStream('petite.sql.gz', chunked(data, 7777));
            assert.equal(written, data.length);
            assert.equal(s3.multipartCount, 0, 'pas d’envoi multiple sous le seuil');
            assert.deepEqual(s3.objects.get('petite.sql.gz'), data);
        } finally {
            await s3.close();
        }
    });

    it('bascule en envoi multiple et recolle l’archive à l’identique', async () => {
        const s3 = await startFakeS3();
        try {
            // Juste au-delà de deux parties : le reliquat final est plus petit
            // que les autres, ce que S3 n'admet QUE sur la dernière.
            const data = crypto.randomBytes(S3_PART_BYTES * 2 + 12_345);
            // Découpage volontairement désaligné du seuil : c'est le cas réel
            // (un `mysqldump` ne rend pas des blocs de 16 Mio).
            const written = await clientFor(s3.port).putStream('grosse.sql.gz', chunked(data, 999_983));
            assert.equal(written, data.length);
            assert.ok(s3.multipartCount === 1, 'un seul envoi multiple ouvert');
            const sizes = s3.partSizes;
            assert.deepEqual(
                sizes.slice(0, -1),
                sizes.slice(0, -1).map(() => S3_PART_BYTES),
                'toutes les parties sauf la dernière font la taille pleine'
            );
            assert.equal(sizes[sizes.length - 1], data.length - S3_PART_BYTES * (sizes.length - 1));
            assert.deepEqual(s3.objects.get('grosse.sql.gz'), data);
        } finally {
            await s3.close();
        }
    });

    it('relit, liste et efface ce qu’il a écrit', async () => {
        const s3 = await startFakeS3();
        try {
            const client = clientFor(s3.port);
            const data = crypto.randomBytes(4096);
            await client.putStream('nuit/base.sql.gz', chunked(data, 1024));

            const parts: Buffer[] = [];
            for await (const chunk of client.getObject('nuit/base.sql.gz')) parts.push(chunk);
            assert.deepEqual(Buffer.concat(parts), data);

            const listed = await client.listObjects('nuit/');
            assert.deepEqual(listed, [{ key: 'nuit/base.sql.gz', size: data.length }]);

            await client.deleteObject('nuit/base.sql.gz');
            assert.deepEqual(await client.listObjects('nuit/'), []);
        } finally {
            await s3.close();
        }
    });

    it('traduit une erreur du service en phrase corrigeable', async () => {
        const s3 = await startFakeS3();
        try {
            await assert.rejects(
                async () => {
                    for await (const _ of clientFor(s3.port).getObject('jamais-ecrit')) void _;
                },
                (e: Error) => {
                    // La phrase doit dire où chercher, pas « HTTP 404 ».
                    assert.match(e.message, /bucket|introuvable/i);
                    return true;
                }
            );
        } finally {
            await s3.close();
        }
    });
});
