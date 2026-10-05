import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ImapFlow } from 'imapflow';

import { FLAG } from '../engine/mailstore';
import { createTestEngine, sampleMessage, selfSigned, testTlsStore } from '../testing/harness';
import { createImapServer, type ImapServer } from './server';

/**
 * Le serveur piloté par le vrai client de Mail, dans la forme d'options de
 * `features/mail/src/server/client.ts` : ce que ce test prouve, c'est que Mail
 * sait relever une boîte hébergée ici.
 */

const engine = createTestEngine();
let server: ImapServer;
let port = 0;

function client(user = 'bob@exemple.test', pass = 'secret-de-bob'): ImapFlow {
    return new ImapFlow({
        host: 'localhost',
        port,
        secure: true,
        auth: { user, pass },
        tls: { ca: selfSigned().cert },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        logger: false
    });
}

async function deliver(subject: string, folder = 'INBOX', flags = 0): Promise<number> {
    const mailbox = await engine.repo.findByAddress('bob@exemple.test');
    assert.ok(mailbox);
    const target = await engine.repo.findFolder(mailbox.id, folder);
    assert.ok(target);
    const row = await engine.store.append(mailbox, target, sampleMessage(subject, `Corps de ${subject}.`), {
        internalDate: 1_788_000_000,
        flags
    });
    return row.uid;
}

before(async () => {
    await engine.createMailbox('bob@exemple.test', 'secret-de-bob');
    server = createImapServer(
        {
            repo: engine.repo,
            store: engine.store,
            auth: engine.auth,
            notifier: engine.notifier,
            hostname: 'localhost',
            maxMessageBytes: 1024 * 1024,
            logger: engine.deps.logger
        },
        testTlsStore()
    );
    port = await server.listen(0);
});

after(async () => {
    await server.stop();
    engine.events.stop();
});

describe('imapflow contre le serveur', () => {
    it('refuse un mauvais mot de passe, accepte le bon sur une connexion chiffrée', async () => {
        const wrong = client('bob@exemple.test', 'faux');
        await assert.rejects(wrong.connect());
        wrong.close();

        const ok = client();
        await ok.connect();
        assert.equal(ok.secureConnection, true);
        assert.ok(ok.capabilities.has('MOVE'));
        assert.ok(ok.capabilities.has('UIDPLUS'));
        await ok.logout();
    });

    it('liste les dossiers avec leurs usages spéciaux', async () => {
        const c = client();
        await c.connect();
        const list = await c.list();
        const byPath = new Map(list.map((entry) => [entry.path, entry]));
        assert.deepEqual([...byPath.keys()].sort(), ['Archive', 'Drafts', 'INBOX', 'Junk', 'Sent', 'Trash']);
        assert.equal(byPath.get('Sent')?.specialUse, '\\Sent');
        assert.equal(byPath.get('Trash')?.specialUse, '\\Trash');
        assert.equal(byPath.get('INBOX')?.delimiter, '/');
        await c.logout();
    });

    it('relève comme Mail : par numéro de séquence d’abord, puis par UID depuis le dernier vu', async () => {
        const first = await deliver('Premier');
        const second = await deliver('Deuxième =?UTF-8?Q?accentu=C3=A9?=');
        const c = client();
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try {
            const box = c.mailbox;
            assert.ok(box && typeof box === 'object');
            assert.equal(box.exists, 2);
            const query = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true } as const;

            const initial = [];
            for await (const msg of c.fetch(`1:${box.exists}`, query)) initial.push(msg);
            assert.deepEqual(
                initial.map((m) => m.uid),
                [first, second]
            );
            assert.equal(initial[0].envelope?.subject, 'Premier');
            assert.equal(initial[1].envelope?.subject, 'Deuxième accentué');
            assert.equal(initial[0].envelope?.from?.[0]?.address, 'alice@ailleurs.test');
            assert.equal(initial[0].bodyStructure?.type, 'text/plain');
            assert.equal(initial[0].flags?.size, 0);
            assert.ok(initial[0].internalDate instanceof Date);

            const third = await deliver('Troisième');
            const since = [];
            for await (const msg of c.fetch(`${second + 1}:*`, query, { uid: true })) since.push(msg.uid);
            assert.deepEqual(since, [third]);

            const flagsOnly = [];
            for await (const msg of c.fetch(`${first}:${third}`, { uid: true, flags: true }, { uid: true })) {
                flagsOnly.push(msg.uid);
            }
            assert.deepEqual(flagsOnly, [first, second, third]);
        } finally {
            lock.release();
        }
        await c.logout();
    });

    it('rend le message brut sans le marquer lu, puis pose et retire des drapeaux', async () => {
        const uid = await deliver('Brut');
        const c = client();
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try {
            const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
            assert.ok(msg && msg.source);
            assert.ok(msg.source.toString().includes('Corps de Brut.'));
            const peeked = await c.fetchOne(String(uid), { flags: true }, { uid: true });
            assert.ok(peeked);
            assert.equal(peeked.flags?.has('\\Seen'), false, 'imapflow lit en BODY.PEEK');

            await c.messageFlagsAdd(String(uid), ['\\Seen', '\\Flagged'], { uid: true });
            await c.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
            const after1 = await c.fetchOne(String(uid), { flags: true }, { uid: true });
            assert.ok(after1);
            assert.deepEqual([...(after1.flags ?? [])], ['\\Seen']);
        } finally {
            lock.release();
        }
        await c.logout();
    });

    it('cherche comme Mail, accents et mots encodés compris', async () => {
        await deliver('Facture =?UTF-8?B?w6l0w6k=?=');
        const c = client();
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try {
            const term = (text: string) =>
                c.search(
                    { or: [{ subject: text }, { from: text }, { to: text }, { cc: text }, { body: text }] },
                    { uid: true }
                );
            const all = await c.search({ uid: '1:999' }, { uid: true });
            assert.ok(Array.isArray(all) && all.length >= 5);
            const byWord = await term('ete');
            assert.ok(Array.isArray(byWord));
            assert.equal(byWord.length, 1, 'le sujet encodé « été » se trouve sans accent');
            const byBody = await term('corps de brut');
            assert.ok(Array.isArray(byBody));
            assert.equal(byBody.length, 1);
            assert.deepEqual(await term('introuvable-xyz'), []);
        } finally {
            lock.release();
        }
        await c.logout();
    });

    it('déplace avec COPYUID, puis supprime par \\Deleted et UID EXPUNGE', async () => {
        const moved = await deliver('À déplacer');
        const doomed = await deliver('À supprimer');
        const c = client();
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try {
            const res = await c.messageMove(String(moved), 'Archive', { uid: true });
            assert.ok(res && typeof res === 'object');
            assert.equal(res.uidMap?.size, 1);
            await c.messageFlagsAdd(String(doomed), ['\\Deleted'], { uid: true });
            await c.messageDelete(String(doomed), { uid: true });
        } finally {
            lock.release();
        }
        const archive = await c.status('Archive', { messages: true, unseen: true });
        assert.equal(archive.messages, 1);
        await c.logout();

        const mailbox = await engine.repo.findByAddress('bob@exemple.test');
        assert.ok(mailbox);
        const inbox = await engine.repo.findFolder(mailbox.id, 'INBOX');
        assert.ok(inbox);
        const left = (await engine.repo.listMessages(inbox.id)).map((m) => m.uid);
        assert.ok(!left.includes(moved) && !left.includes(doomed));
        // Le corps supprimé a quitté le disque ; celui du message déplacé a suivi par référence.
        assert.equal(engine.blobs.files.size, engine.repo.messages.length);
    });

    it('APPEND range un message, et une session en IDLE voit ce qui arrive et ce qui part', async () => {
        const watcher = client();
        await watcher.connect();
        const watching = await watcher.getMailboxLock('Drafts');
        const seen: string[] = [];
        watcher.on('exists', (event) => seen.push(`exists:${event.count}`));
        watcher.on('expunge', (event) => seen.push(`expunge:${event.seq}`));
        watcher.on('flags', (event) => seen.push(`flags:${event.uid ?? '?'}`));
        const idling = watcher.idle();

        const writer = client();
        await writer.connect();
        const appended = await writer.append(
            'Drafts',
            sampleMessage('Brouillon'),
            ['\\Draft'],
            new Date(1_788_000_000_000)
        );
        assert.ok(appended && typeof appended === 'object');
        assert.equal(appended.uid, 1);
        const lock = await writer.getMailboxLock('Drafts');
        try {
            await writer.messageFlagsAdd('1', ['\\Flagged'], { uid: true });
            await writer.messageFlagsAdd('1', ['\\Deleted'], { uid: true });
            await writer.messageDelete('1', { uid: true });
        } finally {
            lock.release();
        }
        await writer.logout();

        await new Promise((resolve) => setTimeout(resolve, 300));
        watching.release();
        await idling.catch(() => undefined);
        await watcher.logout();
        assert.deepEqual(
            seen.filter((e) => !e.startsWith('flags')),
            ['exists:1', 'expunge:1']
        );
        assert.ok(seen.includes('flags:1'));
    });

    it('refuse au-delà du quota, et ferme les sessions d’une boîte qu’on éteint', async () => {
        const small = await engine.createMailbox('plein@exemple.test', 'secret-plein', 600);
        const c = client('plein@exemple.test', 'secret-plein');
        await c.connect();
        await assert.rejects(
            c.append('INBOX', sampleMessage('Trop gros', 'x'.repeat(2_000))),
            (error: { serverResponseCode?: string }) => error.serverResponseCode === 'OVERQUOTA'
        );

        const closed = new Promise<void>((resolve) => c.once('close', () => resolve()));
        engine.notifier.dropMailbox(small.id);
        await closed;
        assert.equal(c.usable, false);
    });

    it('une boîte que l’offre met en pause perd sa session, puis refuse la connexion comme une éteinte', async () => {
        const paused = await engine.createMailbox('pause@exemple.test', 'secret-pause');
        const c = client('pause@exemple.test', 'secret-pause');
        await c.connect();
        const closed = new Promise<void>((resolve) => c.once('close', () => resolve()));
        engine.paused.push(String(paused.id));
        try {
            // Ce que le moteur fait des boîtes que `onPlanPause` lui nomme.
            engine.notifier.dropMailbox(paused.id);
            await closed;
            const refused = client('pause@exemple.test', 'secret-pause');
            await assert.rejects(refused.connect());
            refused.close();
        } finally {
            engine.paused.splice(0);
        }
        const resumed = client('pause@exemple.test', 'secret-pause');
        await resumed.connect();
        await resumed.logout();
    });

    it('marque lu un message lu par un client qui ne dit pas PEEK', async () => {
        const uid = await deliver('Sans peek', 'Junk');
        const mailbox = await engine.repo.findByAddress('bob@exemple.test');
        assert.ok(mailbox);
        const junk = await engine.repo.findFolder(mailbox.id, 'Junk');
        assert.ok(junk);
        const c = client();
        await c.connect();
        const lock = await c.getMailboxLock('Junk');
        try {
            // `exec` est la porte basse d'imapflow, hors de ses types : elle envoie la commande telle quelle.
            const low = c as unknown as {
                exec(command: string, attributes: unknown[]): Promise<{ next(): void }>;
            };
            const response = await low.exec('UID FETCH', [
                { type: 'SEQUENCE', value: String(uid) },
                [{ type: 'ATOM', value: 'BODY', section: [] }]
            ]);
            response.next();
        } finally {
            lock.release();
        }
        await c.logout();
        const row = await engine.repo.findMessage(junk.id, uid);
        assert.equal((row?.flags ?? 0) & FLAG.Seen, FLAG.Seen);
    });
});
