import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext, testDomain } from '@deveye/types/sdk/testing';

import type { z } from 'zod';

import type { mailserverCommands } from '../contracts/commands';
import { manifest } from '../manifest';
import { setEngine, type EngineHandle } from './_shared';
import { mailserverHandlers } from './handlers';
import { verifySecret } from './passwords';
import { memoryRepo } from './testing/memoryRepo';

const DOMAINS = [
    testDomain({ id: 1, host: 'exemple.test' }),
    testDomain({ id: 2, host: 'attente.test', verified: false, verifiedAt: null }),
    testDomain({ id: 3, host: 'ailleurs.test', workspaceId: 2 })
];

function setup(overrides: Parameters<typeof createTestContext>[0] = {}) {
    const repo = memoryRepo();
    const ctx = createTestContext({ repo, manifest, domains: DOMAINS, ...overrides });
    return { repo, ctx };
}

type Context = ReturnType<typeof setup>['ctx'];
type Contract = (typeof mailserverCommands)[number];
type ContractOf<C extends Contract['command']> = Extract<Contract, { command: C }>;

/** La sortie d'une commande, validée par SON contrat : le test lit ce qu'un client lirait. */
async function run<C extends Contract['command']>(
    ctx: Context,
    command: C,
    input: z.input<ContractOf<C>['input']>
): Promise<z.output<ContractOf<C>['output']>> {
    const def = mailserverHandlers.find((d) => d.command === command);
    assert.ok(def, command);
    const out = await (def.handler as (c: unknown, i: unknown) => Promise<unknown>)(ctx, def.input.parse(input));
    return def.output.parse(out) as z.output<ContractOf<C>['output']>;
}

const code = (expected: string) => (error: unknown) => error instanceof FeatureError && error.code === expected;
const base = { displayName: 'Bob', quotaMb: 100 };

describe('mailserver.create', () => {
    it('crée l’adresse, ses dossiers, et ne garde du mot de passe que son hachage', async () => {
        const { repo, ctx } = setup();
        const out = await run(ctx, 'mailserver.create', { ...base, localPart: ' Bob ', domainId: 1 });
        assert.equal(out.mailbox.address, 'bob@exemple.test');
        assert.equal(out.mailbox.domainHost, 'exemple.test');
        assert.equal(out.mailbox.displayName, 'Bob');
        assert.equal(out.mailbox.quotaMb, 100);
        assert.equal(out.password.length, 24);
        assert.equal(await verifySecret(out.password, repo.mailboxes[0].password_hash), true);
        assert.ok(!repo.mailboxes[0].password_hash.includes(out.password));
        assert.deepEqual(repo.folders.map((f) => f.path).sort(), [
            'Archive',
            'Drafts',
            'INBOX',
            'Junk',
            'Sent',
            'Trash'
        ]);
        assert.equal(new Set(repo.folders.map((f) => f.uid_validity)).size, 6);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['mailserver.create']
        );
    });

    it('refuse une partie locale invalide, un domaine en attente, d’un autre espace, ou une adresse prise', async () => {
        const { ctx } = setup();
        for (const localPart of ['a+b', '.a', 'a b', 'é']) {
            await assert.rejects(
                run(ctx, 'mailserver.create', { ...base, localPart, domainId: 1 }),
                code('validation'),
                localPart
            );
        }
        await assert.rejects(
            run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 2 }),
            code('validation')
        );
        await assert.rejects(
            run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 3 }),
            code('not_found')
        );
        await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
        await assert.rejects(run(ctx, 'mailserver.create', { ...base, localPart: 'A', domainId: 1 }), code('conflict'));
    });
});

describe('lire et régler', () => {
    it('la liste tait ce qu’un rôle masque, et la fiche le refuse', async () => {
        const { repo, ctx } = setup();
        await run(ctx, 'mailserver.create', { ...base, localPart: 'un', domainId: 1 });
        await run(ctx, 'mailserver.create', { ...base, localPart: 'deux', domainId: 1 });
        const hidden = createTestContext({ repo, manifest, domains: DOMAINS, itemRestrictions: { '1': 'none' } });
        const list = await run(hidden, 'mailserver.list', {});
        assert.deepEqual(
            list.mailboxes.map((m: { address: string }) => m.address),
            ['deux@exemple.test']
        );
        assert.equal((await run(hidden, 'mailserver.count', {})).count, 1);
        await assert.rejects(run(hidden, 'mailserver.get', { id: 1 }), code('forbidden'));
    });

    it('une boîte d’un autre espace est introuvable', async () => {
        const { repo, ctx } = setup();
        await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
        const other = createTestContext({ repo, manifest, domains: DOMAINS, workspaceId: 2 });
        await assert.rejects(run(other, 'mailserver.get', { id: 1 }), code('not_found'));
        await assert.rejects(run(other, 'mailserver.delete', { id: 1 }), code('not_found'));
    });

    it('régler une boîte, fermer la bannière, et éteindre congédie ses sessions', async () => {
        const dropped: [number, boolean][] = [];
        setEngine({
            dropMailbox: (id: number, purge: boolean) => Promise.resolve(void dropped.push([id, purge]))
        } as unknown as EngineHandle);
        try {
            const { ctx } = setup();
            await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
            const out = await run(ctx, 'mailserver.update', {
                id: 1,
                displayName: ' Alice ',
                quotaMb: 50,
                enabled: false,
                outboundDailyLimit: 10
            });
            assert.deepEqual(
                [out.mailbox.displayName, out.mailbox.quotaMb, out.mailbox.enabled, out.mailbox.outboundDailyLimit],
                ['Alice', 50, false, 10]
            );
            assert.deepEqual(dropped, [[1, false]]);
            assert.equal(
                (await run(ctx, 'mailserver.setBanner', { id: 1, dismissed: true })).mailbox.bannerDismissed,
                true
            );

            await run(ctx, 'mailserver.delete', { id: 1 });
            assert.deepEqual(dropped[1], [1, true]);
            assert.deepEqual((await run(ctx, 'mailserver.list', {})).mailboxes, []);
        } finally {
            setEngine(null);
        }
    });
});

describe('les mots de passe', () => {
    it('un mot de passe d’application se crée, se liste sans son secret, se révoque', async () => {
        const { repo, ctx } = setup();
        await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
        const made = await run(ctx, 'mailserver.appPasswordCreate', { id: 1, label: 'Mails DevEye', forMails: true });
        assert.equal(made.credential.origin, 'mails');
        assert.equal(repo.credentials[0].save_sent, 1);
        assert.equal(await verifySecret(made.secret, repo.credentials[0].secret_hash), true);
        const listed = await run(ctx, 'mailserver.appPasswordList', { id: 1 });
        assert.deepEqual(Object.keys(listed.credentials[0]).sort(), ['created', 'id', 'label', 'lastUsedAt', 'origin']);
        await run(ctx, 'mailserver.appPasswordRevoke', { id: 1, credentialId: made.credential.id });
        await assert.rejects(
            run(ctx, 'mailserver.appPasswordRevoke', { id: 1, credentialId: made.credential.id }),
            code('not_found')
        );
    });

    it('la réinitialisation change le hachage et rend le nouveau mot de passe une fois', async () => {
        const { repo, ctx } = setup();
        const created = await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
        const reset = await run(ctx, 'mailserver.passwordReset', { id: 1 });
        assert.notEqual(reset.password, created.password);
        assert.equal(await verifySecret(created.password, repo.mailboxes[0].password_hash), false);
        assert.equal(await verifySecret(reset.password, repo.mailboxes[0].password_hash), true);
    });

    it('les commandes sensibles déclarent leur permission propre', () => {
        const extras = (command: string) => mailserverHandlers.find((d) => d.command === command)?.access?.extras;
        for (const command of [
            'mailserver.passwordReset',
            'mailserver.appPasswordCreate',
            'mailserver.appPasswordRevoke'
        ]) {
            assert.deepEqual(extras(command), ['managePasswords'], command);
        }
        for (const command of ['mailserver.queueRetry', 'mailserver.queueDrop']) {
            assert.deepEqual(extras(command), ['manageQueue'], command);
        }
    });
});

describe('mailserver.activity', () => {
    it('rend un point par jour, même sans courrier, et les faits récents descellés', async () => {
        const { repo, ctx } = setup();
        await run(ctx, 'mailserver.create', { ...base, localPart: 'a', domainId: 1 });
        const today = new Date().toISOString().slice(0, 10);
        await repo.bumpDaily(1, today, 'received');
        await repo.bumpDaily(1, today, 'received');
        await repo.bumpDaily(1, today, 'sent');
        await repo.insertEvent({
            mailboxId: 1,
            ts: Math.floor(Date.now() / 1000),
            kind: 'received',
            size: 1_200,
            spf: 1,
            dkim: 2,
            dmarc: 0,
            content: JSON.stringify({ peer: 'x@ailleurs.test', detail: '' })
        });
        const out = await run(ctx, 'mailserver.activity', { id: 1, days: 7 });
        assert.equal(out.daily.length, 7);
        assert.deepEqual(out.daily[6], { day: today, received: 2, sent: 1, rejected: 0, bounced: 0 });
        assert.deepEqual(out.totals, { received: 2, sent: 1, rejected: 0, bounced: 0 });
        assert.deepEqual(
            [out.recent[0].peer, out.recent[0].spf, out.recent[0].dkim, out.recent[0].dmarc],
            ['x@ailleurs.test', 'pass', 'fail', 'none']
        );
    });
});
