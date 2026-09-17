import assert from 'node:assert/strict';
import test from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestDomainsContext, testDomain } from '@deveye/types/sdk/testing';

import { createDomainHooks } from './domains';
import type { MailserverRepo } from './repo';
import { memoryRepo } from './testing/memoryRepo';

const DOMAIN = testDomain({ id: 1, host: 'exemple.test' });
const hooks = createDomainHooks('mx.deveye.test');

test('sans nom d’hôte configuré, rien à publier et une sonde qui dit pourquoi', async () => {
    const ctx = createTestDomainsContext<MailserverRepo>({ repo: memoryRepo() });
    const bare = createDomainHooks('');
    assert.deepEqual(await bare.records(ctx, DOMAIN), []);
    assert.deepEqual(await bare.probe(ctx, DOMAIN), {
        ok: false,
        error: 'Le serveur mail n’est pas configuré (MAILSERVER_HOSTNAME).'
    });
});

test('MX, SPF, DKIM et DMARC, avec une clé créée une fois pour le domaine', async () => {
    const repo = memoryRepo();
    const ctx = createTestDomainsContext<MailserverRepo>({ repo });
    const records = await hooks.records(ctx, DOMAIN);
    assert.deepEqual(records[0], { type: 'MX', name: 'exemple.test', value: 'mx.deveye.test', priority: 10 });
    assert.deepEqual(records[1], { type: 'TXT', name: 'exemple.test', value: 'v=spf1 mx -all' });
    assert.match(records[2].name, /^dv\d{6}\._domainkey\.exemple\.test$/);
    assert.match(records[2].value, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{300,}$/);
    assert.deepEqual(records[3], { type: 'TXT', name: '_dmarc.exemple.test', value: 'v=DMARC1; p=quarantine' });
    assert.deepEqual(await hooks.records(ctx, DOMAIN), records, 'la clé ne change pas d’un appel à l’autre');
    // La clé privée n'est jamais en clair dans la base.
    const key = await repo.findDomainKey('exemple.test');
    assert.ok(key && !key.private_key.includes('PRIVATE KEY'));
});

test('la sonde veut le MX et la clé DKIM publiée, espaces et point final tolérés', async () => {
    const repo = memoryRepo();
    const dkim = (await hooks.records(createTestDomainsContext<MailserverRepo>({ repo }), DOMAIN))[2];
    const probe = (mx: string[], txt: string[]) =>
        hooks.probe(
            createTestDomainsContext<MailserverRepo>({
                repo,
                dns: {
                    mx: () => Promise.resolve(mx.map((exchange) => ({ exchange, priority: 10 }))),
                    txt: (name) => Promise.resolve(name === dkim.name ? txt : [])
                }
            }),
            DOMAIN
        );

    assert.match(((await probe([], [])) as { error: string }).error, /Aucun enregistrement MX/);
    assert.match(
        ((await probe(['mx.autre.test'], [])) as { error: string }).error,
        /vise mx\.autre\.test, pas mx\.deveye\.test/
    );
    assert.match(((await probe(['mx.deveye.test'], ['v=DKIM1; p=autre'])) as { error: string }).error, /DKIM/);
    const spaced = dkim.value.replace('p=', 'p= ').replace(/(.{60})/g, '$1 ');
    assert.deepEqual(await probe(['MX.DevEye.test.'], [spaced]), { ok: true });
});

test('un domaine qui porte encore des adresses ne se retire pas', async () => {
    const repo = memoryRepo();
    const ctx = createTestDomainsContext<MailserverRepo>({ repo });
    await assert.doesNotReject(hooks.onRemoved?.(ctx, DOMAIN) ?? Promise.resolve());
    await repo.createMailbox({
        workspaceId: 1,
        domainId: 1,
        localPart: 'a',
        address: 'a@exemple.test',
        passwordHash: 'x',
        quotaBytes: 1,
        outboundDailyLimit: 1,
        blobKey: 'k',
        content: '{}',
        now: 1
    });
    assert.deepEqual([...((await hooks.useCount?.(ctx, 1)) ?? [])], [[1, 1]]);
    await assert.rejects(
        hooks.onRemoved?.(ctx, DOMAIN) ?? Promise.resolve(),
        (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
    );
});
