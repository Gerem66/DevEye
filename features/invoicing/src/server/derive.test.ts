import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { todayIn } from '../contracts/calendar';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { clientSave } from './handlers/clients';
import { docDerive } from './handlers/derive';
import { docGet, docSave, linesSet } from './handlers/docs';
import { docIssue, docStatus } from './handlers/issue';
import { paperInputOf } from './paperInput';

const DAY = todayIn('Europe/Paris');

const MANIFEST = {
    extraPermissions: [
        { key: 'issue', label: 'Émettre', description: '', type: 'toggle' as const },
        { key: 'issuer', label: 'Émetteur', description: '', type: 'toggle' as const }
    ]
};

function ctxOf(store: MemoryStore, over: Record<string, unknown> = {}) {
    return createTestContext({
        repo: memoryRepo(store),
        workspaceId: 1,
        manifest: MANIFEST,
        extras: { issue: true, issuer: true },
        ...over
    });
}

function readyWorkspace(store: MemoryStore): void {
    store.settings.set(1, {
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
        domain_id: null,
        content: JSON.stringify({
            issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', siret: '81234567800017' },
            wording: DEFAULT_SETTINGS.wording
        })
    });
}

const EMPTY_CLIENT = {
    kind: 'company' as const,
    name: 'Mairie de Nowhere',
    contactName: '',
    email: '',
    phone: '',
    address: '',
    postalCode: '',
    city: '',
    country: 'France',
    siret: '',
    vatNumber: '',
    note: '',
    paymentTermsDays: null,
    defaultVatBp: null
};

const EMPTY_HEADER = {
    clientId: null as number | null,
    subject: '',
    intro: '',
    notes: '',
    terms: '',
    purchaseOrder: '',
    performedOn: null,
    dueOn: null,
    validUntil: null,
    depositBp: null
};

/** Un devis envoyé, à deux taux de TVA. */
async function sentQuote(store: MemoryStore) {
    readyWorkspace(store);
    const ctx = ctxOf(store);
    const client = await clientSave.handler(ctx, { id: null, client: EMPTY_CLIENT, archived: false });
    const quote = await docSave.handler(ctx, {
        id: null,
        kind: 'quote',
        doc: { ...EMPTY_HEADER, clientId: client.client.id, subject: 'Refonte' }
    });
    await linesSet.handler(ctx, {
        docId: quote.doc.id,
        lines: [
            {
                id: null,
                kind: 'service',
                label: 'Développement',
                description: '',
                quantityMilli: 2000,
                unit: 'day',
                unitPrice: 50_000,
                vatRateBp: 2000
            },
            {
                id: null,
                kind: 'service',
                label: 'Impression',
                description: '',
                quantityMilli: 1000,
                unit: 'unit',
                unitPrice: 20_000,
                vatRateBp: 550
            }
        ]
    });
    await docIssue.handler(ctx, { id: quote.doc.id, issuedOn: DAY });
    return { ctx, id: quote.doc.id, clientId: client.client.id };
}

describe('invoicing.docDerive, la facture d’un devis', () => {
    it('recopie ses lignes dans un brouillon de facture', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);

        const res = await docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 });

        assert.equal(res.doc.kind, 'invoice');
        assert.equal(res.doc.status, 'draft');
        assert.equal(res.doc.parentId, id);
        assert.equal(res.doc.totals.grossCents, 120_000 + 21_100);

        const lines = await docGet.handler(ctx, { id: res.doc.id });
        assert.deepEqual(
            lines.lines.map((line) => line.label),
            ['Développement', 'Impression']
        );
    });

    it('refuse de tirer deux factures du même devis', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);
        await docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 });

        await assert.rejects(
            () => docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse de tirer une facture d’un devis encore en brouillon', async () => {
        const store = emptyStore();
        readyWorkspace(store);
        const ctx = ctxOf(store);
        const quote = await docSave.handler(ctx, { id: null, kind: 'quote', doc: EMPTY_HEADER });

        await assert.rejects(
            () => docDerive.handler(ctx, { id: quote.doc.id, mode: 'invoice', percentBp: 3000 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });
});

describe('invoicing.docDerive, l’acompte', () => {
    it('porte une ligne par taux, à la part demandée', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);

        const res = await docDerive.handler(ctx, { id, mode: 'deposit', percentBp: 3000 });
        const lines = await docGet.handler(ctx, { id: res.doc.id });

        assert.equal(lines.lines.length, 2, 'une ligne par taux du devis');
        assert.deepEqual(
            lines.lines.map((line) => line.vatRateBp),
            [2000, 550]
        );
        assert.equal(lines.lines[0].unitPrice, 30_000, '30 % de la base à 20 %');
        assert.equal(lines.lines[1].unitPrice, 6000, '30 % de la base à 5,5 %');
        assert.ok(lines.lines[0].label.includes('Acompte de 30 %'));
    });

    it('facture au centime l’acompte que le devis annonce', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);
        store.docs.find((d) => d.id === id)!.deposit_bp = 3333;

        const announced = (await paperInputOf(ctx, (await ctx.repo.findDoc(id, 1))!)).deposit;
        const res = await docDerive.handler(ctx, { id, mode: 'deposit', percentBp: 3333 });

        assert.deepEqual(announced, { percentBp: 3333, grossCents: res.doc.totals.grossCents });
    });

    it('la facture de solde déduit l’acompte émis', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);
        const deposit = await docDerive.handler(ctx, { id, mode: 'deposit', percentBp: 3000 });
        await docIssue.handler(ctx, { id: deposit.doc.id, issuedOn: DAY });

        const balance = await docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 });

        const deductions = store.deductions.filter((x) => x.doc_id === balance.doc.id);
        assert.equal(deductions.length, 1);
        assert.equal(deductions[0].deducted_doc_id, deposit.doc.id);
        assert.equal(deductions[0].amount, deposit.doc.totals.grossCents);
    });

    it('un acompte n’empêche pas la facture de solde', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);
        const deposit = await docDerive.handler(ctx, { id, mode: 'deposit', percentBp: 3000 });
        await docIssue.handler(ctx, { id: deposit.doc.id, issuedOn: DAY });

        const balance = await docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 });
        assert.equal(balance.doc.kind, 'invoice');
    });
});

describe('invoicing.docDerive, l’avoir', () => {
    async function issuedInvoice(store: MemoryStore) {
        const { ctx, id } = await sentQuote(store);
        await docStatus.handler(ctx, { id, status: 'accepted' });
        const invoice = await docDerive.handler(ctx, { id, mode: 'invoice', percentBp: 3000 });
        await docIssue.handler(ctx, { id: invoice.doc.id, issuedOn: DAY });
        return { ctx, invoiceId: invoice.doc.id };
    }

    it('recopie la facture qu’il corrige', async () => {
        const store = emptyStore();
        const { ctx, invoiceId } = await issuedInvoice(store);

        const res = await docDerive.handler(ctx, { id: invoiceId, mode: 'credit', percentBp: 3000 });

        assert.equal(res.doc.kind, 'credit');
        assert.equal(res.doc.status, 'draft');
        assert.equal(res.doc.parentId, invoiceId);
        assert.equal(res.doc.totals.grossCents, 120_000 + 21_100);
    });

    it('émis, il annule la facture qu’il couvre en entier', async () => {
        const store = emptyStore();
        const { ctx, invoiceId } = await issuedInvoice(store);
        const credit = await docDerive.handler(ctx, { id: invoiceId, mode: 'credit', percentBp: 3000 });

        await docIssue.handler(ctx, { id: credit.doc.id, issuedOn: DAY });

        const after = await docGet.handler(ctx, { id: invoiceId });
        assert.equal(after.doc.status, 'cancelled');
        assert.equal(after.doc.displayStatus, 'cancelled');
    });

    it('partiel, il laisse la facture vivante et réduit ce qui reste dû', async () => {
        const store = emptyStore();
        const { ctx, invoiceId } = await issuedInvoice(store);
        const credit = await docDerive.handler(ctx, { id: invoiceId, mode: 'credit', percentBp: 3000 });
        // Un avoir partiel se fait en corrigeant son brouillon.
        const lines = await docGet.handler(ctx, { id: credit.doc.id });
        await linesSet.handler(ctx, {
            docId: credit.doc.id,
            lines: [{ ...lines.lines[0], description: lines.lines[0].description ?? '', quantityMilli: 1000 }]
        });
        await docIssue.handler(ctx, { id: credit.doc.id, issuedOn: DAY });

        const after = await docGet.handler(ctx, { id: invoiceId });
        assert.equal(after.doc.status, 'issued');
        assert.equal(after.doc.settledCents, 60_000);
        assert.equal(after.doc.remainingCents, 120_000 + 21_100 - 60_000);
    });

    it('refuse un second avoir sur une facture déjà annulée', async () => {
        const store = emptyStore();
        const { ctx, invoiceId } = await issuedInvoice(store);
        const credit = await docDerive.handler(ctx, { id: invoiceId, mode: 'credit', percentBp: 3000 });
        await docIssue.handler(ctx, { id: credit.doc.id, issuedOn: DAY });

        await assert.rejects(
            () => docDerive.handler(ctx, { id: invoiceId, mode: 'credit', percentBp: 3000 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse un avoir sur un devis', async () => {
        const store = emptyStore();
        const { ctx, id } = await sentQuote(store);

        await assert.rejects(
            () => docDerive.handler(ctx, { id, mode: 'credit', percentBp: 3000 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });
});
