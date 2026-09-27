import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountExportProblem, type SdkExportWriter, type SdkWorkspaceExportContext } from '@deveye/types/sdk/server';

import { createAccountExport } from './accountExport';
import { serverEntry } from './index';
import type { MailserverRepo } from './repo';
import { createTestEngine } from './testing/harness';

const message = (n: number): Buffer =>
    Buffer.from(`From: a@exemple.test\r\nTo: b@exemple.test\r\nSubject: n°${n}\r\n\r\nCorps ${n}.\r\n`);

async function collect(source: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
    if (source instanceof Uint8Array) return Buffer.from(source);
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

function contextFor(engine: ReturnType<typeof createTestEngine>) {
    const files = new Map<string, { bytes: Buffer; mtime?: number }>();
    const out: SdkExportWriter = {
        json: () => Promise.resolve(),
        rows: () => Promise.resolve(),
        table: () => Promise.resolve(),
        async file(path, bytes, opts) {
            files.set(path, { bytes: await collect(bytes), mtime: opts?.mtime });
        }
    };
    const ctx: SdkWorkspaceExportContext<MailserverRepo> = {
        repo: engine.repo,
        q: { query: () => Promise.reject(new Error('pas de SQL ici')), execute: () => Promise.reject(new Error('')) },
        userId: 1,
        out,
        includes: () => true,
        keys: engine.deps.keys,
        signal: new AbortController().signal,
        logger: engine.deps.logger,
        workspace: { id: 1, kind: 'personal', name: 'Perso' },
        cipher: () => engine.deps.cipherFor(1),
        open: (blob) => Promise.resolve(blob)
    };
    return { ctx, files };
}

describe('l’export du serveur mail', () => {
    it('déclare chacune de ses tables sans faute', () => {
        assert.ok(serverEntry.accountExport);
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('écrit chaque message en .eml, rangé par adresse et par dossier, page après page', async () => {
        const engine = createTestEngine();
        const mailbox = await engine.createMailbox('alice@exemple.test', 'secret-d-alice');
        const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
        assert.ok(inbox);
        await engine.repo.createFolder({
            mailboxId: mailbox.id,
            path: 'Projets/2026',
            specialUse: null,
            uidValidity: 9
        });
        const nested = await engine.repo.findFolder(mailbox.id, 'Projets/2026');
        assert.ok(nested);
        for (let n = 0; n < 201; n++) {
            await engine.store.append(mailbox, inbox, message(n), { internalDate: 1_788_000_000 + n });
        }
        const last = await engine.store.append(mailbox, nested, message(999), { internalDate: 1_788_000_500 });

        const exported = createAccountExport(engine.blobs);
        const { ctx, files } = contextFor(engine);
        await exported.workspace?.(ctx);

        assert.equal(files.size, 202);
        const nestedPath = `Boîtes/alice@exemple.test/Projets/2026/2026-08-29T10-48-20-${last.id}.eml`;
        assert.equal(files.get(nestedPath)?.bytes.toString(), message(999).toString());
        assert.equal(files.get(nestedPath)?.mtime, 1_788_000_500);
        assert.ok([...files.keys()].every((p) => p.startsWith('Boîtes/alice@exemple.test/')));
        assert.equal(
            await exported.files?.bodies.bytes({ repo: engine.repo, q: ctx.q, userId: 1, workspaceIds: [1] }),
            (await engine.repo.findById(mailbox.id))?.used_bytes
        );
    });

    it('écrit les autres quand un corps manque, puis le signale', async () => {
        const engine = createTestEngine();
        const mailbox = await engine.createMailbox('bob@exemple.test', 'secret-de-bob');
        const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
        assert.ok(inbox);
        await engine.store.append(mailbox, inbox, message(1), { internalDate: 1_788_000_000 });
        await engine.store.append(mailbox, inbox, message(2), { internalDate: 1_788_000_001 });
        engine.blobs.files.delete([...engine.blobs.files.keys()][0]);

        const { ctx, files } = contextFor(engine);
        await assert.rejects(createAccountExport(engine.blobs).workspace?.(ctx) ?? Promise.resolve(), /1 message/);
        assert.equal(files.size, 1);
    });
});
