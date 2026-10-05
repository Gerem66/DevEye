import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestContext, createTestDomainsContext, testDomain } from '@deveye/types/sdk/testing';

import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { createDomainHooks } from './domains';
import { emptyStore, memoryRepo } from './_memoryRepo';
import type { InvoicingRepo, InvoicingSettingsRow } from './repo';
import { publicOriginOf } from './_shared';

const DOMAIN = testDomain({ id: 4, workspaceId: 1, host: 'factures.dupont.fr', token: 'jeton' });

function settingsRow(domainId: number | null): InvoicingSettingsRow {
    return {
        currency: 'EUR',
        time_zone: 'Europe/Paris',
        vat_regime: 'standard',
        default_vat_bp: 2000,
        payment_terms_days: 30,
        quote_validity_days: 30,
        default_deposit_bp: 0,
        quote_prefix: 'D',
        invoice_prefix: 'F',
        credit_prefix: 'A',
        number_reset: 'yearly',
        number_start: 1,
        number_pad: 4,
        mail_sender_id: null,
        domain_id: domainId,
        content: '{}'
    };
}

describe('les crochets de domaine', () => {
    it('le CNAME vise l’hôte public de DevEye', async () => {
        const ctx = createTestDomainsContext<InvoicingRepo>({
            origins: { app: 'https://app.test', public: 'https://pub.test', site: null }
        });
        assert.deepEqual(await createDomainHooks().records(ctx, DOMAIN), [
            { type: 'CNAME', name: 'factures.dupont.fr', value: 'pub.test' }
        ]);
    });

    it('la sonde compare le corps au jeton, et dit la vraie cause d’un échec réseau', async () => {
        const ctx = createTestDomainsContext<InvoicingRepo>();
        const asked: string[] = [];
        const ok = await createDomainHooks({
            fetchProof: (url) => {
                asked.push(url);
                return Promise.resolve(' jeton\n');
            }
        }).probe(ctx, DOMAIN);
        assert.deepEqual(ok, { ok: true });
        assert.deepEqual(asked, ['https://factures.dupont.fr/.well-known/deveye-invoicing']);

        const other = await createDomainHooks({ fetchProof: () => Promise.resolve('autre') }).probe(ctx, DOMAIN);
        assert.equal(other.ok, false);

        const wrapped = new TypeError('fetch failed', { cause: new Error('self-signed certificate') });
        const down = await createDomainHooks({ fetchProof: () => Promise.reject(wrapped) }).probe(ctx, DOMAIN);
        assert.deepEqual(down, { ok: false, error: 'self-signed certificate' });
    });

    it('le domaine des réglages compte pour un, et son retrait le libère', async () => {
        const store = emptyStore();
        store.settings.set(1, settingsRow(4));
        const ctx = createTestDomainsContext<InvoicingRepo>({ repo: memoryRepo(store) });
        const hooks = createDomainHooks();

        assert.deepEqual([...(await hooks.useCount!(ctx, 1))], [[4, 1]]);
        await hooks.onRemoved!(ctx, DOMAIN);
        assert.equal(store.settings.get(1)?.domain_id, null);
        assert.deepEqual([...(await hooks.useCount!(ctx, 1))], []);
    });
});

describe('publicOriginOf', () => {
    const ctxWith = (domains = [DOMAIN]) =>
        createTestContext({ repo: memoryRepo(emptyStore()), workspaceId: 1, domains });

    it('prend le domaine choisi tant qu’il est vérifié', async () => {
        assert.equal(
            await publicOriginOf(ctxWith(), { ...DEFAULT_SETTINGS, domainId: 4 }),
            'https://factures.dupont.fr'
        );
    });

    it('retombe sur l’adresse de DevEye sans domaine, ou avec un domaine qui ne l’est plus', async () => {
        assert.equal(await publicOriginOf(ctxWith(), DEFAULT_SETTINGS), 'https://public.deveye.test');
        const lapsed = ctxWith([{ ...DOMAIN, verified: false, verifiedAt: null }]);
        assert.equal(await publicOriginOf(lapsed, { ...DEFAULT_SETTINGS, domainId: 4 }), 'https://public.deveye.test');
        assert.equal(
            await publicOriginOf(ctxWith([]), { ...DEFAULT_SETTINGS, domainId: 4 }),
            'https://public.deveye.test'
        );
    });
});
