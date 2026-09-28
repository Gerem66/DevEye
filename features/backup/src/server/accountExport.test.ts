import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    accountExportProblem,
    sealStream,
    type SdkExportWriter,
    type SdkWorkspaceExportContext
} from '@deveye/types/sdk/server';
import { createTestServiceDeps, memoryObjectStore } from '@deveye/types/sdk/testing';

import { createAccountExport } from './accountExport';
import { backupKey } from './crypto';
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
    it('déclare chacune de ses tables sans faute', () => {
        assert.ok(serverEntry.accountExport);
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('écrit chaque archive ouverte, et tait celles de la base de DevEye', async () => {
        const store = memoryObjectStore();
        await store.put(`ws-${WS}/base-1.sql.gz`, Buffer.from('clair'));
        await store.put(
            `ws-${WS}/nuit/partage-2.tar.gz.enc`,
            await collect(sealStream(backupKey(keys), once(Buffer.from('scellé'))))
        );
        await store.put(`ws-${WS}/deveye-3.sql.gz`, Buffer.from('tous les comptes'));

        const { out, files } = recordingWriter();
        const rows = [
            run(1, `ws-${WS}/base-1.sql.gz`),
            run(2, `ws-${WS}/nuit/partage-2.tar.gz.enc`, { encrypted: 1 }),
            run(3, `ws-${WS}/deveye-3.sql.gz`, { source_kind: 'deveye' })
        ];
        await createAccountExport(() => store).workspace?.(contextFor(rows, out));

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

    it('ne suit aucune clé hors du dossier de l’espace, et le dit', async () => {
        const store = memoryObjectStore();
        await store.put('ws-6/autre.sql.gz', Buffer.from('ailleurs'));
        const { out, files } = recordingWriter();
        await assert.rejects(
            createAccountExport(() => store).workspace?.(
                contextFor([run(4, 'ws-6/autre.sql.gz'), run(5, `ws-${WS}/../ws-6/autre.sql.gz`)], out)
            ) ?? Promise.resolve(),
            /2 archive/
        );
        assert.equal(files.size, 0);
    });
});
