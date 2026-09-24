import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';

// Le faux serveur écoute sur la boucle locale, que le garde des appels sortants
// refuse par défaut.
import { setAllowPrivateForTest } from '@/Services/netFetch';
import { WebDavSink } from './webdav';

before(() => setAllowPrivateForTest(true));
after(() => setAllowPrivateForTest(false));

interface FakeDav {
    url: string;
    files: Map<string, Buffer>;
    folders: Set<string>;
    methods: string[];
    /** Un envoi sans longueur annoncée, comme certains serveurs derrière un proxy. */
    refuseChunked: boolean;
    close(): Promise<void>;
}

/** Un WebDAV réduit à ce que la destination demande, avec un mot de passe exigé. */
async function startFakeDav(): Promise<FakeDav> {
    const files = new Map<string, Buffer>();
    const folders = new Set<string>(['/dav/']);
    const state = { methods: [] as string[], refuseChunked: false };

    const handle = (req: IncomingMessage, res: ServerResponse, body: Buffer): void => {
        const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        state.methods.push(`${req.method} ${path}`);
        if (req.headers.authorization !== `Basic ${Buffer.from('moi:secret').toString('base64')}`) {
            res.writeHead(401).end();
            return;
        }
        const parent = path.replace(/[^/]+\/?$/, '');
        switch (req.method) {
            case 'MKCOL':
                if (folders.has(path)) return void res.writeHead(405).end();
                if (!folders.has(parent)) return void res.writeHead(409).end();
                folders.add(path);
                return void res.writeHead(201).end();
            case 'PUT':
                if (state.refuseChunked && req.headers['content-length'] === undefined) {
                    return void res.writeHead(411).end('Length Required');
                }
                if (!folders.has(parent)) return void res.writeHead(409).end();
                files.set(path, body);
                return void res.writeHead(201).end();
            case 'MOVE': {
                const target = decodeURIComponent(new URL(String(req.headers.destination)).pathname);
                const content = files.get(path);
                if (!content) return void res.writeHead(404).end();
                if (files.has(target) && req.headers.overwrite !== 'T') return void res.writeHead(412).end();
                files.delete(path);
                files.set(target, content);
                return void res.writeHead(201).end();
            }
            case 'GET': {
                const content = files.get(path);
                if (!content) return void res.writeHead(404).end();
                return void res.writeHead(200).end(content);
            }
            case 'DELETE':
                return void res.writeHead(files.delete(path) ? 204 : 404).end();
            case 'PROPFIND':
                res.writeHead(207, { 'content-type': 'application/xml' });
                return void res.end(
                    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>' +
                        '<d:quota-used-bytes>1234</d:quota-used-bytes>' +
                        '<d:quota-available-bytes>-3</d:quota-available-bytes>' +
                        '</d:prop></d:propstat></d:response></d:multistatus>'
                );
            default:
                res.writeHead(405).end();
        }
    };

    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        url: `http://127.0.0.1:${address.port}/dav`,
        files,
        folders,
        get methods() {
            return state.methods;
        },
        get refuseChunked() {
            return state.refuseChunked;
        },
        set refuseChunked(value: boolean) {
            state.refuseChunked = value;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
    for (const part of parts) yield Buffer.from(part);
}

describe('Backup : destination WebDAV', () => {
    let dav: FakeDav;
    afterEach(async () => dav?.close());

    it('écrit sous .part puis renomme, dossiers créés en chemin', async () => {
        dav = await startFakeDav();
        const sink = new WebDavSink({ url: dav.url, username: 'moi', password: 'secret' }, 'Sauvegardes/Nuit');

        const out = await sink.write('base.sql.gz', chunks('dev', 'eye'));

        assert.equal(out.size, 6);
        assert.equal(out.artifact, `${dav.url}/Sauvegardes/Nuit/base.sql.gz`);
        assert.equal(dav.files.get('/dav/Sauvegardes/Nuit/base.sql.gz')?.toString(), 'deveye');
        assert.equal(dav.files.has('/dav/Sauvegardes/Nuit/base.sql.gz.part'), false);
        assert.deepEqual(
            dav.methods.map((m) => m.split(' ')[0]),
            ['MKCOL', 'MKCOL', 'PUT', 'MOVE']
        );
    });

    it('un envoi refusé ne laisse pas de .part, et dit pourquoi', async () => {
        dav = await startFakeDav();
        dav.refuseChunked = true;
        const sink = new WebDavSink({ url: dav.url, username: 'moi', password: 'secret' }, '');

        await assert.rejects(sink.write('base.sql.gz', chunks('deveye')), /411/);
        assert.equal(dav.files.size, 0);
        assert.ok(dav.methods.includes('DELETE /dav/base.sql.gz.part'));
    });

    it('le contrôle passe par le même envoi en flux qu’une archive', async () => {
        dav = await startFakeDav();
        const sink = new WebDavSink({ url: dav.url, username: 'moi', password: 'secret' }, 'Sauvegardes');

        const probe = await sink.probe();
        assert.deepEqual(probe, { ok: true, error: null, usedBytes: 1234, freeBytes: null });
        assert.equal(dav.files.size, 0, 'le témoin est effacé');

        dav.refuseChunked = true;
        const refused = await sink.probe();
        assert.equal(refused.ok, false);
        assert.match(refused.error ?? '', /411/);
    });

    it('un mauvais mot de passe est dit en clair', async () => {
        dav = await startFakeDav();
        const sink = new WebDavSink({ url: dav.url, username: 'moi', password: 'faux' }, 'Sauvegardes');
        const probe = await sink.probe();
        assert.equal(probe.ok, false);
        assert.match(probe.error ?? '', /accès refusé/);
    });

    it('effacer est idempotent, et ne sort pas du dossier', async () => {
        dav = await startFakeDav();
        const sink = new WebDavSink({ url: dav.url, username: 'moi', password: 'secret' }, 'Sauvegardes');
        const { artifact } = await sink.write('a.tar.gz', chunks('x'));

        await sink.remove(artifact);
        await sink.remove(artifact);
        assert.equal(dav.files.size, 0);
        await assert.rejects(sink.remove(`${dav.url}/ailleurs/b.tar.gz`), /hors du dossier/);
    });
});
