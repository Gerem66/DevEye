import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import type { InvoicingDocInput, InvoicingLineInput } from '../contracts/domain';
import { addDays, todayIn } from '../contracts/calendar';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { docGet, docList, docRemove, docSave, linesSet } from './handlers/docs';

const DAY = todayIn('Europe/Paris');

function ctxOf(store: MemoryStore, over: Record<string, unknown> = {}) {
    return createTestContext({ repo: memoryRepo(store), workspaceId: 1, ...over });
}

/**
 * L'espace part en franchise de TVA : un document qui en porte demande donc un
 * espace assujetti, ce que ce raccourci pose.
 */
function liableToVat(store: MemoryStore, over: Record<string, unknown> = {}): void {
    store.settings.set(1, {
        currency: 'EUR',
        time_zone: 'Europe/Paris',
        vat_regime: 'standard',
        default_vat_bp: 2000,
        payment_terms_days: 30,
        quote_validity_days: 30,
        quote_prefix: 'D',
        invoice_prefix: 'F',
        credit_prefix: 'A',
        number_reset: 'yearly',
        number_start: 1,
        number_pad: 4,
        mail_sender_id: null,
        content: '{}',
        ...over
    });
}

function header(over: Partial<InvoicingDocInput> = {}): InvoicingDocInput {
    return {
        clientId: null,
        subject: '',
        intro: '',
        notes: '',
        terms: '',
        purchaseOrder: '',
        performedOn: null,
        dueOn: null,
        validUntil: null,
        ...over
    };
}

function line(over: Partial<InvoicingLineInput> = {}): InvoicingLineInput {
    return {
        id: null,
        kind: 'service',
        label: 'Développement',
        description: '',
        quantityMilli: 1000,
        unit: 'day',
        unitPrice: 50_000,
        vatRateBp: 2000,
        ...over
    };
}

describe('invoicing.docSave', () => {
    it('crée un brouillon sans numéro ni date d’émission', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);

        const res = await docSave.handler(ctx, { id: null, kind: 'quote', doc: header({ subject: 'Refonte' }) });

        assert.equal(res.doc.kind, 'quote');
        assert.equal(res.doc.status, 'draft');
        assert.equal(res.doc.displayStatus, 'draft');
        assert.equal(res.doc.numberLabel, null);
        assert.equal(res.doc.issuedOn, null);
        assert.equal(res.doc.subject, 'Refonte');
        assert.deepEqual(res.doc.totals, { netCents: 0, vatCents: 0, grossCents: 0, vat: [] });
    });

    it('garde l’objet hors des colonnes en clair', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const res = await docSave.handler(ctx, {
            id: null,
            kind: 'quote',
            doc: header({ subject: 'Refonte du site de la mairie' })
        });

        const row = store.docs.find((d) => d.id === res.doc.id);
        assert.ok(row);
        const clear = JSON.stringify({ ...row, content: '' });
        assert.ok(!clear.includes('mairie'));
        assert.ok(row.content.includes('Refonte du site de la mairie'));
    });

    it('fige la devise et le régime de l’espace à la création', async () => {
        const store = emptyStore();
        liableToVat(store, { currency: 'CHF', time_zone: 'Europe/Zurich' });
        const ctx = ctxOf(store);

        const res = await docSave.handler(ctx, { id: null, kind: 'invoice', doc: header() });
        assert.equal(res.doc.currency, 'CHF');
        assert.equal(res.doc.vatRegime, 'standard');
    });

    it('corrige l’en-tête d’un brouillon', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await docSave.handler(ctx, { id: null, kind: 'quote', doc: header() });

        const res = await docSave.handler(ctx, {
            id: created.doc.id,
            kind: 'quote',
            doc: header({ subject: 'Corrigé', validUntil: '2026-10-22' })
        });

        assert.equal(res.doc.subject, 'Corrigé');
        assert.equal(res.doc.validUntil, '2026-10-22');
        assert.equal(store.docs.length, 1);
    });

    it('refuse de toucher à l’en-tête d’un document émis', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, status: 'issued' }));
        const ctx = ctxOf(store);

        await assert.rejects(
            () => docSave.handler(ctx, { id: 10, kind: 'invoice', doc: header({ subject: 'Trop tard' }) }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('ne trouve pas le document d’un autre espace', async () => {
        const ctx = ctxOf(emptyStore());
        await assert.rejects(
            () => docSave.handler(ctx, { id: 999, kind: 'quote', doc: header() }),
            (error: unknown) => error instanceof FeatureError && error.code === 'not_found'
        );
    });
});

describe('invoicing.linesSet', () => {
    async function draftWithLines(store: MemoryStore, lines: InvoicingLineInput[]) {
        liableToVat(store);
        const ctx = ctxOf(store);
        const created = await docSave.handler(ctx, { id: null, kind: 'invoice', doc: header() });
        const res = await linesSet.handler(ctx, { docId: created.doc.id, lines });
        return { ctx, id: created.doc.id, res };
    }

    it('écrit les lignes et rend les totaux', async () => {
        const { res } = await draftWithLines(emptyStore(), [
            line({ quantityMilli: 2000, unitPrice: 50_000 }),
            line({ label: 'Hébergement', quantityMilli: 12_000, unit: 'month', unitPrice: 1500, vatRateBp: 2000 })
        ]);

        assert.equal(res.lines.length, 2);
        assert.equal(res.lines[0].netCents, 100_000);
        assert.equal(res.lines[1].netCents, 18_000);
        assert.equal(res.totals.netCents, 118_000);
        assert.equal(res.totals.vatCents, 23_600);
        assert.equal(res.totals.grossCents, 141_600);
    });

    it('fait la différence par identifiant plutôt que de tout réécrire', async () => {
        const store = emptyStore();
        const { ctx, id, res } = await draftWithLines(store, [line({ label: 'Un' }), line({ label: 'Deux' })]);
        const [first, second] = res.lines;

        const after = await linesSet.handler(ctx, {
            docId: id,
            lines: [
                { ...second, description: second.description ?? '' },
                { ...first, description: first.description ?? '', label: 'Un, corrigé' },
                line({ label: 'Trois' })
            ]
        });

        assert.deepEqual(
            after.lines.map((l) => l.label),
            ['Deux', 'Un, corrigé', 'Trois']
        );
        // Les deux premières ont gardé leur identité : elles ont été corrigées,
        // pas recréées.
        assert.equal(after.lines[0].id, second.id);
        assert.equal(after.lines[1].id, first.id);
    });

    it('retire ce qui a disparu de la saisie', async () => {
        const store = emptyStore();
        const { ctx, id, res } = await draftWithLines(store, [line({ label: 'Un' }), line({ label: 'Deux' })]);

        const after = await linesSet.handler(ctx, {
            docId: id,
            lines: [{ ...res.lines[0], description: res.lines[0].description ?? '' }]
        });
        assert.equal(after.lines.length, 1);
        assert.equal(store.lines.filter((l) => l.doc_id === id).length, 1);
    });

    it('ne compte pas une ligne de commentaire dans les totaux', async () => {
        const { res } = await draftWithLines(emptyStore(), [
            line({ unitPrice: 100_000 }),
            line({ kind: 'text', label: 'Prestations réalisées sur site', unitPrice: 0, vatRateBp: 0 })
        ]);
        assert.equal(res.totals.netCents, 100_000);
        assert.equal(res.totals.vat.length, 1);
    });

    it('ramène les taux à zéro en franchise de TVA, sans refuser l’écriture', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await docSave.handler(ctx, { id: null, kind: 'invoice', doc: header() });

        // Un refus aurait bloqué un brouillon né avant le passage en franchise :
        // l'écran n'y propose plus de taux, donc plus aucun geste ne le débloque.
        const res = await linesSet.handler(ctx, { docId: created.doc.id, lines: [line({ vatRateBp: 2000 })] });

        assert.equal(res.lines[0].vatRateBp, 0);
        assert.equal(res.totals.vatCents, 0);
        assert.equal(store.lines[0].vat_bp, 0, 'la base non plus ne garde pas le taux');
    });

    it('suit le régime de TVA vivant tant que le document est un brouillon', async () => {
        const store = emptyStore();
        liableToVat(store);
        const ctx = ctxOf(store);
        const created = await docSave.handler(ctx, { id: null, kind: 'invoice', doc: header() });
        await linesSet.handler(ctx, { docId: created.doc.id, lines: [line({ vatRateBp: 2000 })] });

        // L'espace repasse en franchise après coup : rien n'est émis, donc tout
        // doit suivre, y compris les taux déjà posés sur les lignes.
        store.settings.get(1)!.vat_regime = 'exempt';
        const exempt = await docGet.handler(ctx, { id: created.doc.id });
        assert.equal(exempt.doc.vatRegime, 'exempt');
        assert.equal(exempt.lines[0].vatRateBp, 0);
        assert.equal(exempt.doc.totals.vatCents, 0);

        store.settings.get(1)!.vat_regime = 'standard';
        const liable = await docGet.handler(ctx, { id: created.doc.id });
        assert.equal(liable.doc.vatRegime, 'standard');
        assert.equal(liable.lines[0].vatRateBp, 2000);
        assert.equal(liable.doc.totals.vatCents, 10_000);
    });

    it('refuse de toucher aux lignes d’un document émis', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, status: 'issued' }));
        const ctx = ctxOf(store);

        await assert.rejects(
            () => linesSet.handler(ctx, { docId: 10, lines: [line()] }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });
});

describe('invoicing.docList', () => {
    it('met les brouillons en tête, puis les émis du plus récent au plus ancien', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 1, issued_on: addDays(DAY, -200), number_label: 'F-0001' }));
        store.docs.push(docRow({ id: 2, issued_on: addDays(DAY, -10), number_label: 'F-0002' }));
        store.docs.push(docRow({ id: 3, status: 'draft', issued_on: null, number_label: null, total_gross: null }));

        const res = await docList.handler(ctxOf(store), {
            kind: null,
            status: null,
            derived: null,
            clientId: null,
            year: null,
            search: '',
            limit: 50,
            offset: 0
        });

        assert.deepEqual(
            res.docs.map((d) => d.id),
            [3, 2, 1]
        );
    });

    it('totalise sur tout le filtre, et dit ce qui est en retard', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 1, due_on: addDays(DAY, -30), total_gross: 120_000 }));
        store.docs.push(docRow({ id: 2, due_on: addDays(DAY, 60), total_gross: 60_000 }));
        store.payments.push({ doc_id: 1, workspace_id: 1, amount: 20_000, paid_on: DAY });

        const res = await docList.handler(ctxOf(store), {
            kind: null,
            status: null,
            derived: null,
            clientId: null,
            year: null,
            search: '',
            limit: 50,
            offset: 0
        });

        assert.equal(res.totals.count, 2);
        assert.equal(res.totals.outstandingCents, 100_000 + 60_000);
        assert.equal(res.totals.overdueCents, 100_000);
    });

    it('cache les documents d’un client qu’un rôle a fermé', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 1, client_id: 7 }));
        store.docs.push(docRow({ id: 2, client_id: 8 }));

        const res = await docList.handler(ctxOf(store, { itemRestrictions: { '7': 'none' } }), {
            kind: null,
            status: null,
            derived: null,
            clientId: null,
            year: null,
            search: '',
            limit: 50,
            offset: 0
        });

        assert.deepEqual(
            res.docs.map((d) => d.id),
            [2]
        );
    });
});

describe('invoicing.docGet', () => {
    it('dit le statut affiché, pas seulement celui qui est stocké', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: '2000-01-01' }));
        const res = await docGet.handler(ctxOf(store), { id: 10 });

        assert.equal(res.doc.status, 'issued');
        assert.equal(res.doc.displayStatus, 'late');
        assert.equal(res.doc.remainingCents, 120_000);
    });

    it('déduit règlements et avoirs du reste dû', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, total_gross: 120_000 }));
        store.docs.push(docRow({ id: 11, kind: 'credit', parent_doc_id: 10, total_gross: 20_000 }));
        store.payments.push({ doc_id: 10, workspace_id: 1, amount: 50_000, paid_on: DAY });

        const res = await docGet.handler(ctxOf(store), { id: 10 });
        assert.equal(res.doc.settledCents, 70_000);
        assert.equal(res.doc.remainingCents, 50_000);
    });
});

describe('invoicing.docRemove', () => {
    it('supprime un brouillon jamais numéroté', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await docSave.handler(ctx, { id: null, kind: 'quote', doc: header() });

        await docRemove.handler(ctx, { id: created.doc.id });
        assert.equal(store.docs.length, 0);
    });

    it('refuse de supprimer un document émis', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, status: 'issued' }));

        await assert.rejects(
            () => docRemove.handler(ctxOf(store), { id: 10 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
        assert.equal(store.docs.length, 1);
    });

    it('refuse de supprimer un brouillon déjà numéroté, qui ouvrirait un trou', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, status: 'draft', number: 7, number_label: 'F2026-0007' }));

        await assert.rejects(
            () => docRemove.handler(ctxOf(store), { id: 10 }),
            (error: unknown) =>
                error instanceof FeatureError && error.code === 'conflict' && error.message.includes('trou')
        );
    });
});
