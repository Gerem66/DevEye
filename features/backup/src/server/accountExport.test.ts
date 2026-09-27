import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { accountExportProblem, type SdkExportWriter, type SdkWorkspaceExportContext } from '@deveye/types/sdk/server';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { createAccountExport } from './accountExport';
import { backupKey, sealStream } from './crypto';
import { serverEntry } from './index';
import type { BackupRepo, LocalArchiveRow } from './repo';

const WS = 5;
const keys = createTestServiceDeps().keys;

async function* once(data: Buffer): AsyncGenerator<Buffer> {
    yield data;
}

async function collect(source: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
    if (source instanceof Uint8Array) return Buffer.from(source);
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

/** Un écrivain qui garde ce qu'on lui confie, chemin par chemin. */
function recordingWriter() {
    const files = new Map<string, { bytes: Buffer; mtime?: number; compress?: boolean }>();
    const out: SdkExportWriter = {
        json: () => Promise.resolve(),
        rows: () => Promise.resolve(),
        table: () => Promise.resolve(),
        async file(filePath, bytes, opts) {
            files.set(filePath, { bytes: await collect(bytes), ...opts });
        }
    };
    return { out, files };
}

function contextFor(rows: LocalArchiveRow[], out: SdkExportWriter): SdkWorkspaceExportContext<BackupRepo> {
    const identity = {
        encrypt: (s: string) => Promise.resolve(s),
        decrypt: (s: string) => Promise.resolve(s),
        tryDecrypt: (s: string) => Promise.resolve(s)
    };
    return {
        repo: { listLocalArchives: () => Promise.resolve(rows) } as unknown as BackupRepo,
        q: { query: () => Promise.reject(new Error('pas de SQL ici')), execute: () => Promise.reject(new Error('')) },
        userId: 1,
        out,
        includes: () => true,
        keys,
        signal: new AbortController().signal,
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        workspace: { id: WS, kind: 'personal', name: 'Perso' },
        cipher: () => identity,
        open: (blob) => Promise.resolve(blob)
    };
}

const run = (id: number, artifact: string, over: Partial<LocalArchiveRow> = {}): LocalArchiveRow => ({
    id,
    source_kind: 'database',
    encrypted: 0,
    size_bytes: 10,
    finished_at: 1_700_000_000,
    content: JSON.stringify({ artifact, error: null }),
    ...over
});

describe('l’export des sauvegardes', () => {
    let storage: string;
    before(async () => {
        storage = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-export-'));
        await fs.mkdir(path.join(storage, `ws-${WS}`, 'nuit'), { recursive: true });
    });
    after(() => fs.rm(storage, { recursive: true, force: true }));

    it('déclare chacune de ses tables sans faute', () => {
        assert.ok(serverEntry.accountExport);
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('écrit chaque archive ouverte, et tait celles de la base de DevEye', async () => {
        const plainFile = path.join(storage, `ws-${WS}`, 'base-1.sql.gz');
        const sealedFile = path.join(storage, `ws-${WS}`, 'nuit', 'partage-2.tar.gz.enc');
        const serverFile = path.join(storage, `ws-${WS}`, 'deveye-3.sql.gz');
        await fs.writeFile(plainFile, 'clair');
        await fs.writeFile(sealedFile, await collect(sealStream(backupKey(keys), once(Buffer.from('scellé')))));
        await fs.writeFile(serverFile, 'tous les comptes');

        const { out, files } = recordingWriter();
        const rows = [
            run(1, plainFile),
            run(2, sealedFile, { encrypted: 1 }),
            run(3, serverFile, { source_kind: 'deveye' })
        ];
        await createAccountExport(storage).workspace?.(contextFor(rows, out));

        assert.deepEqual([...files.keys()].sort(), [
            'Archives/LISEZMOI.txt',
            'Archives/base-1.sql.gz',
            'Archives/partage-2.tar.gz'
        ]);
        assert.equal(files.get('Archives/base-1.sql.gz')?.bytes.toString(), 'clair');
        assert.equal(files.get('Archives/partage-2.tar.gz')?.bytes.toString(), 'scellé');
        assert.equal(files.get('Archives/base-1.sql.gz')?.compress, false);
        assert.equal(files.get('Archives/base-1.sql.gz')?.mtime, 1_700_000_000);
    });

    it('ne suit aucun chemin hors du dossier de l’espace, et le dit', async () => {
        const { out, files } = recordingWriter();
        const outside = path.join(storage, 'ws-6', 'autre.sql.gz');
        await assert.rejects(
            createAccountExport(storage).workspace?.(contextFor([run(4, outside), run(5, '/etc/passwd')], out)) ??
                Promise.resolve(),
            /2 archive/
        );
        assert.equal(files.size, 0);
    });
});
