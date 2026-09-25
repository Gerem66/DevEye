import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { testDomain } from '@deveye/types/sdk/testing';
import { dkimVerify } from 'mailauth';
import nodemailer from 'nodemailer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { SMTPServer } from 'smtp-server';

import { queueContentSchema, unseal } from '../_shared';
import { dkimRecordName, dkimRecordValue } from '../dkim';
import type { Verdicts } from '../engine/delivery';
import { createTestEngine, selfSigned, testTlsStore } from '../testing/harness';
import { createInboundServer, type SmtpListener } from './inbound';
import { createOutbound } from './outbound';
import { createSubmissionServer } from './submission';
import { createInboundVerifier, dispositionOf, type InboundCheck } from './verify';

const engine = createTestEngine([
    testDomain({ id: 1, host: 'exemple.test' }),
    testDomain({ id: 2, host: 'attente.test', verified: false, verifiedAt: null })
]);

/** Ce que la vérification rend au prochain message : chaque test pose le sien. */
let nextCheck: InboundCheck;
const check = (verdicts: Partial<Verdicts> = {}, policy = 'none'): InboundCheck => ({
    verdicts: { spf: 'pass', dkim: 'none', dmarc: 'none', ...verdicts },
    policy,
    headers: 'Authentication-Results: mx.exemple.test; spf=pass\r\n'
});

let inbound: SmtpListener;
let inboundPort = 0;
let submission: SmtpListener;
let submissionPort = 0;
let kicks = 0;

const send = (
    port: number,
    mail: { from: string; to: string | string[]; subject?: string; text?: string },
    auth?: { user: string; pass: string }
) =>
    nodemailer
        .createTransport({
            host: 'localhost',
            port,
            secure: auth !== undefined,
            auth,
            tls: { ca: selfSigned().cert },
            // Sans STARTTLS côté entrant : le test y parle en clair, comme un MTA sans certificat.
            ignoreTLS: auth === undefined
        })
        .sendMail({ subject: 'Essai', text: 'Bonjour.', ...mail });

const code = (expected: number) => (error: unknown) => (error as { responseCode?: number }).responseCode === expected;

/** Éteinte par son réglage, comme depuis sa fiche. */
async function switchOff(address: string, password: string) {
    const mailbox = await engine.createMailbox(address, password);
    await engine.repo.updateMailbox(mailbox.id, {
        enabled: false,
        quotaBytes: mailbox.quota_bytes,
        outboundDailyLimit: mailbox.outbound_daily_limit,
        content: mailbox.content
    });
    return mailbox;
}

async function inboxOf(address: string, folder = 'INBOX') {
    const mailbox = await engine.repo.findByAddress(address);
    assert.ok(mailbox);
    const row = await engine.repo.findFolder(mailbox.id, folder);
    assert.ok(row);
    const messages = await engine.repo.listMessages(row.id);
    return { mailbox, messages, raw: (index: number) => engine.store.readRaw(mailbox, messages[index]) };
}

before(async () => {
    nextCheck = check();
    await engine.createMailbox('bob@exemple.test', 'secret-de-bob');
    await engine.createMailbox('alice@exemple.test', 'secret-d-alice');
    await engine.createMailbox('plein@exemple.test', 'secret-plein', 300);
    const certificates = testTlsStore();
    inbound = createInboundServer({
        hostname: 'mx.exemple.test',
        maxBytes: 64 * 1024,
        certificates,
        delivery: engine.delivery,
        events: engine.events,
        verify: () => Promise.resolve(nextCheck),
        logger: engine.deps.logger
    });
    inboundPort = await inbound.listen(0);
    submission = createSubmissionServer(
        {
            hostname: 'mx.exemple.test',
            maxBytes: 64 * 1024,
            certificates,
            repo: engine.repo,
            pauses: engine.deps.pauses,
            store: engine.store,
            auth: engine.auth,
            cipherFor: engine.deps.cipherFor,
            kick: () => (kicks += 1),
            logger: engine.deps.logger
        },
        true
    );
    submissionPort = await submission.listen(0);
});

after(async () => {
    await Promise.all([inbound.stop(), submission.stop()]);
    engine.events.stop();
});

describe('le port 25', () => {
    it('remet dans la boîte, en-têtes de trace en tête, et le note au journal', async () => {
        await send(inboundPort, { from: 'expediteur@ailleurs.test', to: 'bob@exemple.test', subject: 'Bien recu' });
        const { mailbox, messages, raw } = await inboxOf('bob@exemple.test');
        assert.equal(messages.length, 1);
        const text = (await raw(0)).toString();
        assert.match(
            text,
            /^Return-Path: <expediteur@ailleurs\.test>\r\nDelivered-To: bob@exemple\.test\r\nReceived: from /
        );
        assert.match(text, /Authentication-Results: mx\.exemple\.test; spf=pass/);
        assert.match(text, /Subject: Bien recu/);
        const fresh = await engine.repo.findById(mailbox.id);
        assert.ok(fresh && fresh.used_bytes > 0 && fresh.message_count === 1 && fresh.last_delivery_at !== null);
        assert.equal(engine.repo.events.filter((e) => e.mailbox_id === mailbox.id && e.kind === 'received').length, 1);
        assert.deepEqual(engine.repo.daily.find((d) => d.mailbox_id === mailbox.id)?.received, 1);
    });

    it('n’est pas un relais : domaine étranger, domaine non vérifié, boîte inconnue sont refusés', async () => {
        for (const to of ['quelquun@autre.test', 'bob@attente.test', 'inconnu@exemple.test']) {
            await assert.rejects(send(inboundPort, { from: 'x@ailleurs.test', to }), code(550), to);
        }
        // Un destinataire valable parmi d'autres suffit à remettre, à lui seul.
        const info = await send(inboundPort, { from: 'x@ailleurs.test', to: ['bob@exemple.test', 'nul@autre.test'] });
        assert.deepEqual(info.accepted, ['bob@exemple.test']);
    });

    it('le sous-adressage arrive dans la boîte de base', async () => {
        const before1 = (await inboxOf('alice@exemple.test')).messages.length;
        await send(inboundPort, { from: 'x@ailleurs.test', to: 'Alice+Listes@exemple.test' });
        assert.equal((await inboxOf('alice@exemple.test')).messages.length, before1 + 1);
    });

    it('suit la politique DMARC de l’expéditeur : refus, ou dossier Indésirables', async () => {
        nextCheck = check({ spf: 'fail', dmarc: 'fail' }, 'reject');
        await assert.rejects(send(inboundPort, { from: 'faux@banque.test', to: 'alice@exemple.test' }), code(550));
        const alice = await engine.repo.findByAddress('alice@exemple.test');
        assert.ok(alice);
        assert.ok(engine.repo.events.some((e) => e.mailbox_id === alice.id && e.kind === 'rejected'));

        nextCheck = check({ dmarc: 'fail' }, 'quarantine');
        await send(inboundPort, { from: 'douteux@ailleurs.test', to: 'alice@exemple.test' });
        assert.equal((await inboxOf('alice@exemple.test', 'Junk')).messages.length, 1);
        nextCheck = check();
    });

    it('une boîte que l’offre tient en pause refuse en 550 comme une éteinte, puis reçoit une fois reprise', async () => {
        await switchOff('eteinte@exemple.test', 'secret-eteinte');
        const paused = await engine.createMailbox('enpause@exemple.test', 'secret-en-pause');
        engine.paused.push(String(paused.id));
        try {
            for (const to of ['eteinte@exemple.test', 'enpause@exemple.test']) {
                await assert.rejects(send(inboundPort, { from: 'x@ailleurs.test', to }), code(550), to);
            }
            // La pause est celle de l'offre : l'état choisi de la boîte ne bouge pas.
            assert.equal((await engine.repo.findById(paused.id))?.enabled, 1);
        } finally {
            engine.paused.splice(0);
        }
        await send(inboundPort, { from: 'x@ailleurs.test', to: 'enpause@exemple.test' });
        assert.equal((await inboxOf('enpause@exemple.test')).messages.length, 1);
    });

    it('une boîte pleine refuse en 552, un message trop gros aussi', async () => {
        await assert.rejects(send(inboundPort, { from: 'x@ailleurs.test', to: 'plein@exemple.test' }), code(552));
        await assert.rejects(
            send(inboundPort, { from: 'x@ailleurs.test', to: 'bob@exemple.test', text: 'x'.repeat(80 * 1024) }),
            code(552)
        );
    });
});

describe('dispositionOf', () => {
    it('ne doute, sans DMARC, que d’un SPF en échec sans signature valable', () => {
        assert.equal(dispositionOf(check({ spf: 'fail' })), 'junk');
        assert.equal(dispositionOf(check({ spf: 'fail', dkim: 'pass' })), 'accept');
        assert.equal(dispositionOf(check({ dmarc: 'fail' }, 'none')), 'accept');
        assert.equal(dispositionOf(check({ spf: 'none' })), 'accept');
    });
});

describe('la vérification réelle', () => {
    it('lit le SPF du domaine de l’expéditeur par le résolveur qu’on lui donne', async () => {
        const verify = createInboundVerifier('mx.exemple.test', (domain, rrtype) => {
            if (rrtype === 'TXT' && domain === 'ailleurs.test')
                return Promise.resolve([['v=spf1 ip4:192.0.2.10 -all']]);
            return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        });
        const raw = Buffer.from('From: x@ailleurs.test\r\nSubject: s\r\n\r\ncorps\r\n');
        const good = await verify(raw, { ip: '192.0.2.10', helo: 'mta.ailleurs.test', sender: 'x@ailleurs.test' });
        assert.equal(good.verdicts.spf, 'pass');
        assert.match(good.headers, /^Received-SPF: pass|Authentication-Results:/m);
        assert.ok(good.headers.endsWith('\r\n'));
        const bad = await verify(raw, { ip: '198.51.100.7', helo: 'mta.ailleurs.test', sender: 'x@ailleurs.test' });
        assert.equal(bad.verdicts.spf, 'fail');
        assert.equal(dispositionOf(bad), 'junk');
    });
});

describe('la soumission', () => {
    const bob = { user: 'bob@exemple.test', pass: 'secret-de-bob' };

    it('exige une authentification, et refuse d’écrire sous un autre nom', async () => {
        await assert.rejects(
            send(submissionPort, { from: 'bob@exemple.test', to: 'x@ailleurs.test' }, { ...bob, pass: 'faux' }),
            code(535)
        );
        await assert.rejects(
            send(submissionPort, { from: 'alice@exemple.test', to: 'x@ailleurs.test' }, bob),
            code(553)
        );
        // L'enveloppe juste, mais un `From:` d'en-tête usurpé.
        await assert.rejects(
            nodemailer
                .createTransport({
                    host: 'localhost',
                    port: submissionPort,
                    secure: true,
                    auth: bob,
                    tls: { ca: selfSigned().cert }
                })
                .sendMail({
                    envelope: { from: 'bob@exemple.test', to: ['x@ailleurs.test'] },
                    from: 'pdg@exemple.test',
                    text: 'x'
                }),
            code(553)
        );
        assert.equal(engine.repo.queue.length, 0);
    });

    it('une boîte que l’offre tient en pause refuse l’authentification en 535, comme une éteinte', async () => {
        await switchOff('muette@exemple.test', 'secret-muette');
        const paused = await engine.createMailbox('suspendue@exemple.test', 'secret-suspendue');
        engine.paused.push(String(paused.id));
        try {
            for (const [user, pass] of [
                ['muette@exemple.test', 'secret-muette'],
                ['suspendue@exemple.test', 'secret-suspendue']
            ]) {
                await assert.rejects(
                    send(submissionPort, { from: user, to: 'x@ailleurs.test' }, { user, pass }),
                    code(535),
                    user
                );
            }
        } finally {
            engine.paused.splice(0);
        }
        assert.equal(engine.repo.queue.length, 0);
    });

    it('une session authentifiée avant la pause n’envoie plus rien', async () => {
        const mailbox = await engine.createMailbox('ouverte@exemple.test', 'secret-ouverte');
        const connection = new SMTPConnection({
            host: 'localhost',
            port: submissionPort,
            secure: true,
            tls: { ca: selfSigned().cert }
        });
        await new Promise<void>((resolve, reject) => {
            connection.once('error', reject);
            connection.connect(() => resolve());
        });
        connection.on('error', () => undefined);
        await new Promise<void>((resolve, reject) =>
            connection.login({ user: mailbox.address, pass: 'secret-ouverte' }, (error) =>
                error ? reject(error) : resolve()
            )
        );
        engine.paused.push(String(mailbox.id));
        try {
            await assert.rejects(
                new Promise((resolve, reject) =>
                    connection.send(
                        { from: mailbox.address, to: ['x@ailleurs.test'] },
                        'Subject: x\r\n\r\nx\r\n',
                        (error, info) => (error ? reject(error) : resolve(info))
                    )
                ),
                code(535)
            );
        } finally {
            engine.paused.splice(0);
            connection.quit();
        }
        assert.equal(engine.repo.queue.length, 0);
    });

    it('met en file une ligne par destinataire sur un seul corps, et range la copie pour Mails', async () => {
        const mailbox = await engine.repo.findByAddress('bob@exemple.test');
        assert.ok(mailbox);
        const { hashSecret } = await import('../passwords');
        await engine.repo.createCredential({
            mailboxId: mailbox.id,
            label: 'Mails DevEye',
            secretHash: await hashSecret('mot-de-passe-application'),
            origin: 'mails',
            saveSent: true,
            createdBy: 1,
            now: 1
        });
        kicks = 0;
        await send(
            submissionPort,
            { from: 'bob@exemple.test', to: ['un@ailleurs.test', 'deux@ailleurs.test'], subject: 'Parti' },
            { user: 'bob@exemple.test', pass: 'mot-de-passe-application' }
        );
        assert.equal(kicks, 1);
        assert.equal(engine.repo.queue.length, 2);
        const blobIds = new Set(engine.repo.queue.map((q) => q.blob_id));
        assert.equal(blobIds.size, 1);
        // Deux destinataires et la copie : trois références sur le même fichier.
        assert.equal(engine.repo.blobs.find((b) => b.id === [...blobIds][0])?.refs, 3);
        const sent = await inboxOf('bob@exemple.test', 'Sent');
        assert.equal(sent.messages.length, 1);
        assert.equal(sent.messages[0].flags & 1, 1, 'rangée déjà lue');
        assert.match((await sent.raw(0)).toString(), /^Received: from .*\r\n\tby mx\.exemple\.test with ESMTPSA/);

        const content = await unseal(engine.deps.cipherFor(1), engine.repo.queue[0].content, queueContentSchema, {
            from: '',
            rcpt: '',
            lastError: ''
        });
        assert.deepEqual(content, { from: 'bob@exemple.test', rcpt: 'un@ailleurs.test', lastError: '' });
    });

    it('respecte le plafond journalier de la boîte', async () => {
        const mailbox = await engine.repo.findByAddress('alice@exemple.test');
        assert.ok(mailbox);
        await engine.repo.updateMailbox(mailbox.id, {
            enabled: true,
            quotaBytes: mailbox.quota_bytes,
            outboundDailyLimit: 1,
            content: mailbox.content
        });
        const alice = { user: 'alice@exemple.test', pass: 'secret-d-alice' };
        await send(submissionPort, { from: 'alice@exemple.test', to: 'x@ailleurs.test' }, alice);
        await assert.rejects(
            send(submissionPort, { from: 'alice@exemple.test', to: 'y@ailleurs.test' }, alice),
            code(450)
        );
    });
});

describe('la file d’envoi', () => {
    const received: { rcpt: string; raw: string }[] = [];
    let refuse: number | null = null;
    let sink: SMTPServer;
    let sinkPort = 0;

    const outbound = () =>
        createOutbound(
            {
                hostname: 'mx.exemple.test',
                repo: engine.repo,
                store: engine.store,
                delivery: engine.delivery,
                events: engine.events,
                keys: engine.deps.keys,
                cipherFor: engine.deps.cipherFor,
                ipv4Only: true,
                allowPrivate: true,
                logger: engine.deps.logger
            },
            {
                resolveMx: (domain) =>
                    Promise.resolve(
                        domain === 'sansmx.test'
                            ? [{ exchange: '.', priority: 0 }]
                            : [{ exchange: 'mx.puits.test', priority: 10 }]
                    ),
                resolveHost: () => Promise.resolve(['127.0.0.1']),
                port: sinkPort
            }
        );

    before(async () => {
        sink = new SMTPServer({
            authOptional: true,
            disabledCommands: ['AUTH', 'STARTTLS'],
            logger: false,
            onRcptTo(_address, _session, done) {
                if (refuse !== null) return done(Object.assign(new Error('refus du puits'), { responseCode: refuse }));
                done();
            },
            onData(stream, session, done) {
                const chunks: Buffer[] = [];
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                stream.on('end', () => {
                    received.push({
                        rcpt: session.envelope.rcptTo[0].address,
                        raw: Buffer.concat(chunks).toString('latin1')
                    });
                    done();
                });
            }
        });
        await new Promise<void>((resolve) => sink.listen(0, resolve));
        const address = sink.server.address();
        sinkPort = typeof address === 'object' && address ? address.port : 0;
    });

    after(() => new Promise<void>((resolve) => sink.close(() => resolve())));

    it('remet chaque ligne signée DKIM, vide la file, et garde le corps tant que la copie le tient', async () => {
        await outbound().runOnce();
        const mine = received.filter((r) => r.rcpt.endsWith('@ailleurs.test'));
        assert.ok(mine.length >= 2);
        assert.match(mine[0].raw, /^DKIM-Signature: /m);

        const key = await engine.repo.findDomainKey('exemple.test');
        assert.ok(key);
        const verdict = await dkimVerify(Buffer.from(mine[0].raw, 'latin1'), {
            resolver: (name, rrtype) =>
                name === dkimRecordName(key) && rrtype === 'TXT'
                    ? Promise.resolve([[dkimRecordValue(key)]])
                    : Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
        });
        assert.equal(verdict.results[0]?.status.result, 'pass');
        assert.equal(verdict.results[0]?.signingDomain, 'exemple.test');

        assert.equal(engine.repo.queue.length, 0);
        const bob = await engine.repo.findByAddress('bob@exemple.test');
        assert.ok(bob);
        assert.ok(engine.repo.events.filter((e) => e.mailbox_id === bob.id && e.kind === 'sent').length >= 2);
        // Il ne reste au corps que la référence de la copie rangée dans Envoyés.
        const sent = await inboxOf('bob@exemple.test', 'Sent');
        assert.equal(engine.repo.blobs.find((b) => b.id === sent.messages[0].blob_id)?.refs, 1);
    });

    it('un refus temporaire reporte l’essai, un refus définitif rend un avis à l’expéditeur', async () => {
        const bob = { user: 'bob@exemple.test', pass: 'secret-de-bob' };
        await send(submissionPort, { from: 'bob@exemple.test', to: 'lent@ailleurs.test', subject: 'A reporter' }, bob);
        refuse = 451;
        await outbound().runOnce();
        assert.equal(engine.repo.queue.length, 1);
        assert.equal(engine.repo.queue[0].status, 'deferred');
        assert.equal(engine.repo.queue[0].attempts, 1);
        assert.ok(engine.repo.queue[0].next_attempt_at > Math.floor(Date.now() / 1000) + 200);

        engine.repo.queue[0].next_attempt_at = 0;
        refuse = 550;
        const inboxBefore = (await inboxOf('bob@exemple.test')).messages.length;
        await outbound().runOnce();
        refuse = null;
        assert.equal(engine.repo.queue.length, 0);
        const inbox = await inboxOf('bob@exemple.test');
        assert.equal(inbox.messages.length, inboxBefore + 1);
        const notice = (await inbox.raw(inbox.messages.length - 1)).toString();
        assert.match(notice, /Content-Type: multipart\/report; report-type=delivery-status/);
        assert.match(notice, /Final-Recipient: rfc822; lent@ailleurs\.test/);
        assert.match(notice, /Subject: A reporter/);
        assert.ok(engine.repo.events.some((e) => e.kind === 'bounced'));
    });

    it('un domaine qui ne reçoit pas de courrier est rendu tout de suite, une boîte d’ici est servie sans réseau', async () => {
        const bob = { user: 'bob@exemple.test', pass: 'secret-de-bob' };
        const seen = received.length;
        await send(
            submissionPort,
            { from: 'bob@exemple.test', to: ['x@sansmx.test', 'alice@exemple.test'], subject: 'Local' },
            bob
        );
        const aliceBefore = (await inboxOf('alice@exemple.test')).messages.length;
        await outbound().runOnce();
        assert.equal(engine.repo.queue.length, 0);
        assert.equal(received.length, seen, 'rien n’est sorti sur le réseau');
        assert.equal((await inboxOf('alice@exemple.test')).messages.length, aliceBefore + 1);
        const inbox = await inboxOf('bob@exemple.test');
        assert.match((await inbox.raw(inbox.messages.length - 1)).toString(), /5\.1\.10/);
    });
});
