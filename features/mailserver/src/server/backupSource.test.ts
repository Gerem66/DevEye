import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBackupProvider } from './backupSource';
import { createTestEngine } from './testing/harness';

const message = (n: number): Buffer =>
    Buffer.from(`From: a@exemple.test\r\nTo: b@exemple.test\r\nSubject: n°${n}\r\n\r\nCorps ${n}.\r\n`);

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

describe('la source de sauvegarde du serveur mail', () => {
    it('rend les adresses, leurs dossiers, leurs messages et leurs corps en clair', async () => {
        const engine = createTestEngine();
        const mailbox = await engine.createMailbox('alice@exemple.test', 'secret-d-alice');
        const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
        assert.ok(inbox);
        const first = await engine.store.append(mailbox, inbox, message(1), {
            internalDate: 1_788_000_000,
            flags: 1 | 4,
            keywords: '$Forwarded Projet'
        });
        await engine.store.append(mailbox, inbox, message(2), { internalDate: 1_788_000_001 });

        const provider = createBackupProvider(engine.deps, engine.blobs);
        assert.deepEqual(
            (await provider.listMailboxes(1)).map((m) => m.address),
            ['alice@exemple.test']
        );
        assert.equal(await provider.findMailbox(mailbox.id, 2), null);

        const folders = await provider.folders(mailbox.id);
        const box = folders.find((f) => f.path === 'INBOX');
        assert.ok(box);
        assert.deepEqual(box.keywords, ['$Forwarded', 'Projet']);
        assert.ok(
            folders.some((f) => f.path !== 'INBOX'),
            'les dossiers vides comptent aussi'
        );

        const page = await provider.messages(mailbox.id, box.id, 0, 1);
        assert.equal(page.length, 1);
        assert.deepEqual(page[0].flags, ['seen', 'flagged']);
        assert.deepEqual(page[0].keywords, ['$Forwarded', 'Projet']);
        assert.equal(page[0].size, message(1).length);
        const next = await provider.messages(mailbox.id, box.id, page[0].uid, 10);
        assert.equal(next.length, 1);
        assert.deepEqual(next[0].flags, []);

        const body = await provider.open(mailbox.id, first.id);
        assert.ok(body);
        assert.equal((await collect(body)).toString(), message(1).toString());
    });

    it('rend null pour un message effacé entre la liste et la lecture', async () => {
        const engine = createTestEngine();
        const mailbox = await engine.createMailbox('bob@exemple.test', 'secret-de-bob');
        const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
        assert.ok(inbox);
        const row = await engine.store.append(mailbox, inbox, message(1), { internalDate: 1_788_000_000 });
        engine.blobs.files.clear();

        const provider = createBackupProvider(engine.deps, engine.blobs);
        assert.equal(await provider.open(mailbox.id, row.id), null);
        assert.equal(await provider.open(mailbox.id, row.id + 1000), null);
    });

    it('ne laisse lire le courrier qu’à qui peut gérer les mots de passe de l’adresse', async () => {
        const engine = createTestEngine();
        const asked: unknown[] = [];
        const provider = createBackupProvider(
            {
                ...engine.deps,
                access: {
                    ...engine.deps.access,
                    feature: (workspaceId, userId, need) => {
                        asked.push({ workspaceId, userId, need });
                        return Promise.resolve({ ok: false, reason: 'not_granted' });
                    }
                }
            },
            engine.blobs
        );
        assert.deepEqual(await provider.authorize(7, 1, 3), { ok: false, reason: 'not_granted' });
        assert.deepEqual(asked, [
            { workspaceId: 1, userId: 3, need: { level: 'write', extras: ['managePasswords'], itemId: '7' } }
        ]);
    });
});
