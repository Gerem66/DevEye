import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
// Import par défaut : ssh2 est en CommonJS, et Node n'en voit pas `Server` comme export nommé.
import ssh2, { type Connection, type SFTPWrapper } from 'ssh2';

// Le faux serveur écoute sur la boucle locale, que le garde des connexions
// sortantes refuse par défaut.
import { setAllowPrivateForTest } from '@/Services/netFetch';
import { hostKeyFingerprint, SftpSink, type SftpConfig } from './sftp';

before(() => setAllowPrivateForTest(true));
after(() => setAllowPrivateForTest(false));

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

const HOST_KEY = utils.generateKeyPairSync('ed25519').private;
const parsed = utils.parseKey(HOST_KEY);
assert.ok(!(parsed instanceof Error));
const FINGERPRINT = hostKeyFingerprint(parsed.getPublicSSH());

interface FakeSftp {
    port: number;
    files: Map<string, Buffer>;
    folders: Set<string>;
    connections: number;
    close(): Promise<void>;
}

const attrs = (mode: number, size: number) => ({ mode, uid: 0, gid: 0, size, atime: 0, mtime: 0 });

/** Un serveur SFTP en mémoire : ce qu'une destination demande, sans plus. */
function serve(sftp: SFTPWrapper, files: Map<string, Buffer>, folders: Set<string>): void {
    const handles = new Map<number, { path: string; listed?: boolean }>();
    let next = 0;
    const open = (entry: { path: string }): Buffer => {
        const id = next++;
        handles.set(id, entry);
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(id);
        return buf;
    };
    const entryOf = (handle: Buffer) => handles.get(handle.readUInt32BE(0));

    sftp.on('OPEN', (reqid, filename) => {
        files.set(filename, Buffer.alloc(0));
        sftp.handle(reqid, open({ path: filename }));
    })
        .on('WRITE', (reqid, handle, offset, data) => {
            const entry = entryOf(handle);
            if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const current = files.get(entry.path) ?? Buffer.alloc(0);
            const grown = Buffer.alloc(Math.max(current.length, offset + data.length));
            current.copy(grown);
            data.copy(grown, offset);
            files.set(entry.path, grown);
            sftp.status(reqid, STATUS_CODE.OK);
        })
        .on('CLOSE', (reqid, handle) => {
            handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
        })
        .on('STAT', (reqid, path) => {
            if (folders.has(path)) return sftp.attrs(reqid, attrs(S_IFDIR | 0o755, 0));
            const file = files.get(path);
            if (file) return sftp.attrs(reqid, attrs(S_IFREG | 0o644, file.length));
            sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        })
        .on('MKDIR', (reqid, path) => {
            folders.add(path);
            sftp.status(reqid, STATUS_CODE.OK);
        })
        .on('REMOVE', (reqid, path) => {
            sftp.status(reqid, files.delete(path) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE);
        })
        .on('RENAME', (reqid, from, to) => {
            // Comme SFTPv3 : renommer sur un fichier existant est un échec.
            const content = files.get(from);
            if (!content || files.has(to)) return sftp.status(reqid, STATUS_CODE.FAILURE);
            files.delete(from);
            files.set(to, content);
            sftp.status(reqid, STATUS_CODE.OK);
        })
        .on('OPENDIR', (reqid, path) => sftp.handle(reqid, open({ path })))
        .on('READDIR', (reqid, handle) => {
            const entry = entryOf(handle);
            if (!entry || entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
            entry.listed = true;
            const prefix = entry.path === '.' ? '' : `${entry.path}/`;
            const names = [...files.entries()]
                .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
                .map(([p, content]) => {
                    const filename = p.slice(prefix.length);
                    return { filename, longname: filename, attrs: attrs(S_IFREG | 0o644, content.length) };
                });
            sftp.name(reqid, names);
        });
}

async function startFakeSftp(): Promise<FakeSftp> {
    const files = new Map<string, Buffer>();
    const folders = new Set<string>();
    const state = { connections: 0 };
    const server = new Server({ hostKeys: [HOST_KEY] }, (client: Connection) => {
        state.connections += 1;
        client
            .on('authentication', (ctx) => {
                if (ctx.method === 'password' && ctx.username === 'deveye' && ctx.password === 'secret') ctx.accept();
                else ctx.reject(['password']);
            })
            .on('ready', () => {
                client.on('session', (accept) => {
                    accept().on('sftp', (acceptSftp) => serve(acceptSftp(), files, folders));
                });
            })
            .on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        files,
        folders,
        get connections() {
            return state.connections;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

function config(port: number, over: Partial<SftpConfig> = {}): SftpConfig {
    return {
        host: '127.0.0.1',
        port,
        username: 'deveye',
        auth: 'password',
        secret: 'secret',
        hostKey: FINGERPRINT,
        ...over
    };
}

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
    for (const part of parts) yield Buffer.from(part);
}

describe('Backup : destination SFTP', () => {
    let sftp: FakeSftp;
    afterEach(async () => sftp?.close());

    it('rien ne part vers un serveur dont l’empreinte n’a pas été validée', async () => {
        sftp = await startFakeSftp();
        const sink = new SftpSink(config(sftp.port, { hostKey: null }), 'sauvegardes');

        await assert.rejects(sink.write('base.sql.gz', chunks('deveye')), /pas encore été validée/);
        assert.equal(sftp.connections, 0);
    });

    it('le premier contrôle fait connaissance du serveur et vérifie qu’on peut écrire', async () => {
        sftp = await startFakeSftp();
        const sink = new SftpSink(config(sftp.port, { hostKey: null }), 'sauvegardes', true);

        const probe = await sink.probe();
        assert.equal(probe.ok, true, probe.error ?? undefined);
        assert.equal(sink.seenHostKey, FINGERPRINT);
        assert.equal(sftp.files.size, 0, 'le témoin est effacé');
        assert.ok(sftp.folders.has('sauvegardes'));
    });

    it('écrit sous .part puis remplace, dossiers créés en chemin', async () => {
        sftp = await startFakeSftp();
        const sink = new SftpSink(config(sftp.port), 'sauvegardes/nuit');

        const first = await sink.write('base.sql.gz', chunks('dev', 'eye'));
        assert.deepEqual(first, { artifact: 'sauvegardes/nuit/base.sql.gz', size: 6 });
        assert.equal(sftp.files.get('sauvegardes/nuit/base.sql.gz')?.toString(), 'deveye');
        assert.equal(sftp.files.has('sauvegardes/nuit/base.sql.gz.part'), false);

        // Sans l'extension OpenSSH, le fichier existant est effacé avant le renommage.
        await sink.write('base.sql.gz', chunks('encore'));
        assert.equal(sftp.files.get('sauvegardes/nuit/base.sql.gz')?.toString(), 'encore');
    });

    it('une empreinte changée arrête tout et le dit', async () => {
        sftp = await startFakeSftp();
        const sink = new SftpSink(config(sftp.port, { hostKey: 'SHA256:autre' }), 'sauvegardes');

        const probe = await sink.probe();
        assert.equal(probe.ok, false);
        assert.match(probe.error ?? '', /a changé/);
        await assert.rejects(sink.write('base.sql.gz', chunks('deveye')), /a changé/);
        assert.equal(sftp.files.size, 0);
    });

    it('effacer est idempotent, et ne sort pas du dossier', async () => {
        sftp = await startFakeSftp();
        const sink = new SftpSink(config(sftp.port), 'sauvegardes');
        const { artifact } = await sink.write('a.tar.gz', chunks('x'));

        await sink.remove(artifact);
        await sink.remove(artifact);
        assert.equal(sftp.files.size, 0);
        await assert.rejects(sink.remove('/etc/passwd'), /hors du dossier/);
    });
});
