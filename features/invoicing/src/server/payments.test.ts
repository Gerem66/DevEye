import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { addDays, startOfMonth, todayIn } from '../contracts/calendar';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { docSave, linesSet } from './handlers/docs';
import { dashboard, paymentRemove, paymentSave } from './handlers/payments';
import { serverEntry } from './index';

const DAY = todayIn('Europe/Paris');

function ctxOf(store: MemoryStore, over: Record<string, unknown> = {}) {
    return createTestContext({ repo: memoryRepo(store), workspaceId: 1, quotas: serverEntry.quotas, ...over });
}

function payment(over: Record<string, unknown> = {}) {
    return { paidOn: DAY, amountCents: 50_000, method: 'transfer' as const, reference: '', note: '', ...over };
}

describe('invoicing.paymentSave', () => {
    it('enregistre un règlement partiel et rend le reste dû', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, total_gross: 120_000 }));
        const ctx = ctxOf(store);

        const res = await paymentSave.handler(ctx, { docId: 10, payment: payment() });

        assert.equal(res.payments.length, 1);
        assert.equal(res.doc.settledCents, 50_000);
        assert.equal(res.doc.remainingCents, 70_000);
        assert.equal(res.doc.displayStatus, 'partial');
    });

    it('garde la référence bancaire hors des colonnes en clair', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10 }));
        const ctx = ctxOf(store);

        await paymentSave.handler(ctx, { docId: 10, payment: payment({ reference: 'VIR-99812' }) });

        const row = store.payments[0];
        const clear = JSON.stringify({ ...row, content: '' });
        assert.ok(!clear.includes('VIR-99812'));
        assert.ok((row.content ?? '').includes('VIR-99812'));
    });

    it('solde la facture au centime près, et prévient une seule fois', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, total_gross: 120_000 }));
        const ctx = ctxOf(store);

        await paymentSave.handler(ctx, { docId: 10, payment: payment({ amountCents: 119_999 }) });
        assert.equal(ctx.recorded.notifications.length, 0, 'un centime manque, rien n’est annoncé');

        const res = await paymentSave.handler(ctx, { docId: 10, payment: payment({ amountCents: 1 }) });
        assert.equal(res.doc.displayStatus, 'paid');
        assert.equal(res.doc.remainingCents, 0);
        assert.equal(ctx.recorded.notifications.length, 1);
        assert.ok(ctx.recorded.notifications[0].subject.includes('soldée'));
    });

    it('refuse un règlement plus grand que le reste dû', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, total_gross: 120_000 }));
        const ctx = ctxOf(store);

        await assert.rejects(
            () => paymentSave.handler(ctx, { docId: 10, payment: payment({ amountCents: 130_000 }) }),
            (error: unknown) =>
                error instanceof FeatureError && error.code === 'conflict' && error.message.includes('avoir')
        );
        assert.equal(store.payments.length, 0);
    });

    it('refuse un règlement sur un brouillon', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, status: 'draft', total_gross: null }));

        await assert.rejects(
            () => paymentSave.handler(ctxOf(store), { docId: 10, payment: payment() }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse un règlement sur un devis', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, kind: 'quote', status: 'sent' }));

        await assert.rejects(
            () => paymentSave.handler(ctxOf(store), { docId: 10, payment: payment() }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });
});

describe('invoicing.paymentRemove', () => {
    it('retire un règlement et rouvre le reste dû', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, total_gross: 120_000 }));
        const ctx = ctxOf(store);
        const saved = await paymentSave.handler(ctx, { docId: 10, payment: payment() });

        const res = await paymentRemove.handler(ctx, { docId: 10, id: saved.payments[0].id });
        assert.equal(res.payments.length, 0);
        assert.equal(res.doc.remainingCents, 120_000);
    });

    it('ne retire pas un règlement qui n’existe pas', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10 }));

        await assert.rejects(
            () => paymentRemove.handler(ctxOf(store), { docId: 10, id: 999 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'not_found'
        );
    });
});

describe('invoicing.dashboard', () => {
    it('sépare ce qui est facturé de ce qui est encaissé', async () => {
        const store = emptyStore();
        store.docs.push(
            docRow({ id: 10, issued_on: DAY, total_net: 100_000, total_vat: 20_000, total_gross: 120_000 })
        );
        store.payments.push({ doc_id: 10, workspace_id: 1, amount: 60_000, paid_on: DAY });

        const res = await dashboard.handler(ctxOf(store), { range: 'month', recent: 5 });

        assert.equal(res.dashboard.billedCents, 120_000);
        assert.equal(res.dashboard.cashedCents, 60_000);
        assert.equal(res.dashboard.outstandingCents, 60_000);
        assert.equal(res.dashboard.from, startOfMonth(DAY));
    });

    it('compte la TVA sur ce qui est encaissé, pas sur ce qui est facturé', async () => {
        const store = emptyStore();
        store.docs.push(
            docRow({ id: 10, issued_on: DAY, total_net: 100_000, total_vat: 20_000, total_gross: 120_000 })
        );
        // La moitié réglée : la moitié de la taxe est due.
        store.payments.push({ doc_id: 10, workspace_id: 1, amount: 60_000, paid_on: DAY });

        const res = await dashboard.handler(ctxOf(store), { range: 'month', recent: 5 });
        assert.equal(res.dashboard.vatCollectedCents, 10_000);
    });

    it('déduit les avoirs du facturé', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, issued_on: DAY, total_gross: 120_000 }));
        store.docs.push(docRow({ id: 11, kind: 'credit', parent_doc_id: 10, issued_on: DAY, total_gross: 20_000 }));

        const res = await dashboard.handler(ctxOf(store), { range: 'month', recent: 5 });
        assert.equal(res.dashboard.billedCents, 100_000);
    });

    it('liste ce qui demande un geste : les retards, puis les devis qui expirent', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: addDays(DAY, -10), total_gross: 120_000 }));
        store.docs.push(docRow({ id: 11, due_on: addDays(DAY, 30), total_gross: 60_000 }));
        store.docs.push(docRow({ id: 12, kind: 'quote', status: 'sent', due_on: null, valid_until: addDays(DAY, 3) }));
        store.docs.push(docRow({ id: 13, kind: 'quote', status: 'sent', due_on: null, valid_until: addDays(DAY, 60) }));

        const res = await dashboard.handler(ctxOf(store), { range: 'month', recent: 5 });
        assert.deepEqual(
            res.actionable.map((doc) => doc.id),
            [10, 12]
        );
        assert.equal(res.dashboard.overdueCents, 120_000);
        assert.equal(res.dashboard.overdueCount, 1);
        assert.equal(res.dashboard.quotesPendingCount, 2);
        assert.equal(res.dashboard.quotesExpiringSoon, 1);
    });

    it('cache ce qui appartient à un client fermé par un rôle', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, client_id: 7, due_on: addDays(DAY, -10) }));
        store.docs.push(docRow({ id: 11, client_id: 8, due_on: addDays(DAY, -10) }));

        const res = await dashboard.handler(ctxOf(store, { itemRestrictions: { '7': 'none' } }), {
            range: 'month',
            recent: 5
        });
        assert.deepEqual(
            res.actionable.map((doc) => doc.id),
            [11]
        );
    });

    it('montre un brouillon au total de ses lignes, pas à zéro', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const header = {
            clientId: null,
            subject: '',
            intro: '',
            notes: '',
            terms: '',
            purchaseOrder: '',
            performedOn: null,
            dueOn: null,
            validUntil: null
        };
        const created = await docSave.handler(ctx, { id: null, kind: 'quote', doc: header });
        await linesSet.handler(ctx, {
            docId: created.doc.id,
            lines: [
                {
                    id: null,
                    kind: 'service',
                    label: 'Développement',
                    description: '',
                    quantityMilli: 3000,
                    unit: 'day',
                    unitPrice: 50_000,
                    vatRateBp: 0
                }
            ]
        });

        const res = await dashboard.handler(ctx, { range: 'month', recent: 5 });
        const draft = res.recentDocs.find((doc) => doc.id === created.doc.id);
        assert.equal(draft?.totals.grossCents, 150_000);
    });

    it('dit ce que l’offre permet ce mois-ci', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, issued_on: DAY }));

        const open = await dashboard.handler(ctxOf(store), { range: 'month', recent: 5 });
        assert.equal(open.dashboard.usage, null);

        const bounded = await dashboard.handler(
            ctxOf(store, { quotaLimits: { quotesPerMonth: 3, invoicesPerMonth: 3 } }),
            { range: 'month', recent: 5 }
        );
        assert.deepEqual(bounded.dashboard.usage, {
            quotes: { limit: 3, used: 0 },
            invoices: { limit: 3, used: 1 }
        });
    });
});
