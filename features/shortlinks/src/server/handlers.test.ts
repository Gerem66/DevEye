import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, testDomain } from '@deveye/types/sdk/testing';
import type { z, ZodType } from 'zod';

import {
    shortlinksAdd,
    shortlinksCount,
    shortlinksList,
    shortlinksQr,
    shortlinksRemove,
    shortlinksUpdate,
    shortlinksUpdateAccess
} from '../contracts/commands';
import { SHORTLINK_CODE_PATTERN } from '../contracts/domain';
import { linkRow, memoryRepo } from './_testing';
import { linkHandlers } from './handlers';
import { serverEntry } from './index';
import type { ShortlinksRepo } from './repo';

/**
 * Les commandes d'un membre : ce qu'elles refusent (une destination privée ou
 * vers DevEye, un alias mal formé ou déjà pris, la limite de l'offre, un lien
 * d'un autre espace) et ce qu'elles rendent (l'état lu par l'offre, l'usage).
 */

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = linkHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return (ctx: SdkFeatureContext<ShortlinksRepo>, input: z.input<C['input']>) =>
        def.handler(ctx, contract.input.parse(input) as never) as Promise<z.input<C['output']>>;
}

const code = (expected: string) => (error: unknown) => error instanceof FeatureError && error.code === expected;

const draft = (over: Record<string, unknown> = {}) => ({
    link: { title: 'Rentrée', target: 'https://exemple.fr/offre', domainId: null, slug: null, ...over }
});

describe('shortlinks.add', () => {
    it('crée un lien au code tiré au sort, sur l’adresse de DevEye', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({ repo });
        const { link } = await handlerFor(shortlinksAdd)(ctx, draft());
        assert.match(link.code, SHORTLINK_CODE_PATTERN);
        assert.equal(link.shortUrl, `https://public.deveye.test/l/${link.code}`);
        assert.equal(link.status, 'active');
        assert.equal(link.targets.default, 'https://exemple.fr/offre');
        assert.equal(repo.rows.length, 1);
    });

    it('refuse une destination privée ou vers DevEye', async () => {
        const ctx = createTestContext({ repo: memoryRepo() });
        await assert.rejects(
            handlerFor(shortlinksAdd)(ctx, draft({ target: 'http://192.168.1.1/' })),
            code('validation')
        );
        await assert.rejects(
            handlerFor(shortlinksAdd)(ctx, draft({ target: 'https://public.deveye.test/l/abcdef' })),
            code('validation')
        );
    });

    it('s’arrête à la limite de l’offre, et pile à la limite passe', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({ repo, quotaLimits: { links: 1 } });
        await handlerFor(shortlinksAdd)(ctx, draft());
        await assert.rejects(handlerFor(shortlinksAdd)(ctx, draft()), code('quota_exceeded'));
        const closed = createTestContext({ repo: memoryRepo(), quotaLimits: { links: 0 } });
        await assert.rejects(handlerFor(shortlinksAdd)(closed, draft()), code('quota_exceeded'));
    });

    it('prend un alias sur un domaine de l’espace, en minuscules, une seule fois', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({
            repo,
            domains: [testDomain({ id: 5, host: 'go.exemple.fr', workspaceId: 1 })]
        });
        const { link } = await handlerFor(shortlinksAdd)(ctx, draft({ domainId: 5, slug: '/Promo' }));
        assert.equal(link.slug, 'promo');
        assert.equal(link.domainUrl, 'https://go.exemple.fr/promo');
        await assert.rejects(handlerFor(shortlinksAdd)(ctx, draft({ domainId: 5, slug: 'promo' })), code('conflict'));
        await assert.rejects(handlerFor(shortlinksAdd)(ctx, draft({ domainId: 5, slug: 'é t é' })), code('validation'));
        await assert.rejects(handlerFor(shortlinksAdd)(ctx, draft({ domainId: 9, slug: 'x' })), code('validation'));
    });
});

describe('les réglages d’un lien', () => {
    it('change la destination et l’accès, et une date passée fait expirer le lien', async () => {
        const repo = memoryRepo([linkRow({ id: 1 })]);
        const ctx = createTestContext({ repo });
        const { link } = await handlerFor(shortlinksUpdate)(ctx, {
            id: 1,
            link: {
                title: 'Neuf',
                targets: { default: 'https://exemple.fr/neuf', ios: null, android: 'https://play.google.com/x' },
                domainId: null,
                slug: null,
                checkTarget: false
            }
        });
        assert.equal(link.title, 'Neuf');
        assert.equal(link.targets.android, 'https://play.google.com/x');
        assert.equal(link.check.enabled, false);
        const access = await handlerFor(shortlinksUpdateAccess)(ctx, {
            id: 1,
            access: { password: { mode: 'set', value: 'secret-1' }, expiresAt: null, maxVisits: 10 }
        });
        assert.equal(access.link.hasPassword, true);
        assert.equal(access.link.maxVisits, 10);
        const expired = await handlerFor(shortlinksUpdateAccess)(ctx, {
            id: 1,
            access: { password: { mode: 'keep' }, expiresAt: 1, maxVisits: null }
        });
        assert.equal(expired.link.status, 'expired');
        const kept = await handlerFor(shortlinksUpdateAccess)(ctx, {
            id: 1,
            access: { password: { mode: 'keep' }, expiresAt: null, maxVisits: null }
        });
        assert.equal(kept.link.hasPassword, true);
    });

    it('ne supprime pas le lien d’un autre espace', async () => {
        const ctx = createTestContext({ repo: memoryRepo([linkRow({ id: 1, workspace_id: 7 })]) });
        await assert.rejects(handlerFor(shortlinksRemove)(ctx, { id: 1 }), code('not_found'));
    });

    it('rend le QR code de l’adresse, et refuse celle d’un domaine absent', async () => {
        const ctx = createTestContext({ repo: memoryRepo([linkRow({ id: 1, code: 'abcdef' })]) });
        const qr = await handlerFor(shortlinksQr)(ctx, { id: 1, address: 'short' });
        assert.equal(qr.url, 'https://public.deveye.test/l/abcdef');
        assert.match(qr.svg, /^<svg/);
        await assert.rejects(handlerFor(shortlinksQr)(ctx, { id: 1, address: 'domain' }), code('validation'));
    });
});

describe('la liste et la carte', () => {
    it('lisent l’état par l’offre, masquent ce qu’un rôle ne voit pas, et rendent l’usage', async () => {
        const repo = memoryRepo([
            linkRow({ id: 1, code: 'abcdef', created: 1 }),
            linkRow({ id: 2, code: 'bcdefg', created: 2 }),
            linkRow({ id: 3, code: 'cdefgh', created: 3 })
        ]);
        const ctx = createTestContext({
            repo,
            itemRestrictions: { 3: 'none' },
            pausedItems: { links: ['2'] },
            quotas: serverEntry.quotas,
            quotaLimits: { links: 1, visits: 100 }
        });
        const { links, usage } = await handlerFor(shortlinksList)(ctx, {});
        assert.deepEqual(
            links.map((l) => [l.id, l.status]),
            [
                [2, 'planPaused'],
                [1, 'active']
            ]
        );
        assert.deepEqual(usage.links, { used: 3, limit: 1 });
        assert.deepEqual(usage.visits, { used: 0, limit: 100 });
        assert.deepEqual(await handlerFor(shortlinksCount)(ctx, {}), { total: 2, active: 1, visitsToday: 0 });
    });
});
