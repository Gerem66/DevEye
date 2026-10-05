import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { addDays, todayIn } from '../contracts/calendar';
import { invoicingDocCopySchema } from '../contracts/domain';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { docArchive, docDuplicate, docExport, docImport } from './handlers/copy';
import { docList } from './handlers/docs';

const DAY = todayIn('Europe/Paris');

function ctxOf(store: MemoryStore, workspaceId = 1, over: Record<string, unknown> = {}) {
    return createTestContext({ repo: memoryRepo(store), workspaceId, ...over });
}

function settingsOf(store: MemoryStore, workspaceId: number, vatRegime: 'standard' | 'exempt'): void {
    store.settings.set(workspaceId, {
        currency: 'EUR',
        time_zone: 'Europe/Paris',
        vat_regime: vatRegime,
        default_vat_bp: vatRegime === 'standard' ? 2000 : 0,
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
        content: '{}'
    });
}

function client(store: MemoryStore, id: number, workspaceId: number, name: string, siret = ''): void {
    store.clients.set(id, {
        id,
        workspace_id: workspaceId,
        kind: 'company',
        payment_terms_days: null,
        default_vat_bp: null,
        archived: 0,
        content: JSON.stringify({ name, siret })
    });
}

/** Une facture émise de l'espace 1, avec deux lignes, portée par le client 7. */
function issuedInvoice(store: MemoryStore): void {
    settingsOf(store, 1, 'standard');
    client(store, 7, 1, 'Mairie de Nowhere', '812 345 678 00017');
    store.docs.push(
        docRow({
            id: 50,
            client_id: 7,
            public_token: 'jeton',
            sent_at: 1,
            due_on: addDays(DAY, -40),
            content: JSON.stringify({ subject: 'Refonte', acceptance: { name: 'Jean', at: 1, ip: '', agent: '' } })
        })
    );
    for (const [index, label] of ['Développement', 'Recette'].entries()) {
        store.lines.push({
            id: 500 + index,
            doc_id: 50,
            workspace_id: 1,
            sort_order: index,
            kind: 'service',
            quantity_milli: 1000,
            unit: 'day',
            unit_price: 50_000,
            vat_bp: 2000,
            net_amount: 50_000,
            content: JSON.stringify({ label, description: '' })
        });
    }
    store.nextId = 1000;
}

/** Le document 50 de l'espace 1, porté dans l'espace 2 comme le ferait le navigateur. */
async function carry(store: MemoryStore) {
    const { copy } = await docExport.handler(ctxOf(store), { id: 50 });
    return docImport.handler(ctxOf(store, 2), { copy: invoicingDocCopySchema.parse(copy) });
}

const LIST = {
    kind: null,
    status: null,
    derived: null,
    clientId: null,
    year: null,
    search: '',
    limit: 50,
    offset: 0
} as const;

describe('invoicing.docArchive', () => {
    it('sort un document émis de la liste ordinaire et le range dans les archives', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        const ctx = ctxOf(store);

        const res = await docArchive.handler(ctx, { id: 50, archived: true });
        assert.equal(res.doc.archived, true);

        const listed = await docList.handler(ctx, { ...LIST, archived: false });
        assert.deepEqual(listed.docs, []);
        const archived = await docList.handler(ctx, { ...LIST, archived: true });
        assert.deepEqual(
            archived.docs.map((doc) => doc.id),
            [50]
        );
    });

    it('arrête ses relances, mais pas ce qu’il reste à encaisser', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        const repo = memoryRepo(store);
        await docArchive.handler(ctxOf(store), { id: 50, archived: true });

        assert.deepEqual(await repo.overdueToRemind(DAY, Number.MAX_SAFE_INTEGER, 10), []);
        assert.equal((await repo.outstanding(1, DAY)).outstandingCents, 120_000);
    });

    it('refuse un brouillon, qui se supprime', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 1, status: 'draft', number: null, number_label: null, issued_on: null }));

        await assert.rejects(
            docArchive.handler(ctxOf(store), { id: 1, archived: true }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
    });

    it('ressort un document archivé', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        const ctx = ctxOf(store);
        await docArchive.handler(ctx, { id: 50, archived: true });

        const res = await docArchive.handler(ctx, { id: 50, archived: false });
        assert.equal(res.doc.archived, false);
    });
});

describe('invoicing.docDuplicate', () => {
    it('tire un brouillon neuf d’une facture émise, sans son numéro ni sa remise, échéance repartie d’aujourd’hui', async () => {
        const store = emptyStore();
        issuedInvoice(store);

        const res = await docDuplicate.handler(ctxOf(store), { id: 50 });

        assert.equal(res.doc.status, 'draft');
        assert.equal(res.doc.kind, 'invoice');
        assert.equal(res.doc.numberLabel, null);
        assert.equal(res.doc.clientId, 7);
        assert.equal(res.doc.subject, 'Refonte');
        assert.equal(res.doc.publicUrl, null);
        assert.equal(res.doc.answer, null);
        assert.equal(res.doc.sentAt, null);
        assert.equal(res.doc.dueOn, addDays(DAY, 30));
        assert.equal(res.doc.totals.netCents, 100_000);
        assert.equal(store.lines.filter((line) => line.doc_id === res.doc.id).length, 2);
    });

    it('garde ce qui rattache la pièce : la facture qu’un avoir corrige, les acomptes déduits', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        store.docs.push(docRow({ id: 60, kind: 'credit', parent_doc_id: 50, number_label: 'A-0001' }));
        store.deductions.push({ doc_id: 60, workspace_id: 1, deducted_doc_id: 40, amount: 30_000 });

        const res = await docDuplicate.handler(ctxOf(store), { id: 60 });

        assert.equal(res.doc.kind, 'credit');
        assert.equal(res.doc.parentId, 50);
        assert.deepEqual(
            store.deductions.filter((row) => row.doc_id === res.doc.id).map((row) => row.amount),
            [30_000]
        );
    });

    it('refuse un document dont le client est fermé au rôle', async () => {
        const store = emptyStore();
        issuedInvoice(store);

        await assert.rejects(docDuplicate.handler(ctxOf(store, 1, { itemRestrictions: { '7': 'read' } }), { id: 50 }));
    });
});

describe('invoicing.docExport puis invoicing.docImport', () => {
    it('fait naître un brouillon dans l’autre espace, et y crée le client', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        settingsOf(store, 2, 'standard');

        const res = await carry(store);

        assert.equal(res.clientCreated, true);
        assert.equal(res.doc.status, 'draft');
        assert.equal(res.doc.parentId, null);
        assert.equal(res.doc.clientName, 'Mairie de Nowhere');
        assert.equal(res.doc.totals.vatCents, 20_000);
        const created = [...store.clients.values()].find((row) => row.workspace_id === 2);
        assert.equal(created?.id, res.doc.clientId);
    });

    it('reprend le client d’arrivée qui porte le même nom et le même SIRET', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        settingsOf(store, 2, 'standard');
        client(store, 9, 2, 'MAIRIE de Nowhere ', '81234567800017');

        const res = await carry(store);

        assert.equal(res.clientCreated, false);
        assert.equal(res.doc.clientId, 9);
    });

    it('ne confond pas deux clients de même nom aux SIRET différents', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        settingsOf(store, 2, 'standard');
        client(store, 9, 2, 'Mairie de Nowhere', '99999999900011');

        const res = await carry(store);

        assert.equal(res.clientCreated, true);
        assert.notEqual(res.doc.clientId, 9);
    });

    it('efface les taux dans un espace en franchise', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        settingsOf(store, 2, 'exempt');

        const res = await carry(store);

        assert.equal(res.doc.totals.vatCents, 0);
        assert.deepEqual(
            store.lines.filter((line) => line.doc_id === res.doc.id).map((line) => line.vat_bp),
            [0, 0]
        );
    });

    it('reprend le client figé quand celui d’origine a été retiré', async () => {
        const store = emptyStore();
        issuedInvoice(store);
        store.clients.delete(7);
        const doc = store.docs.find((row) => row.id === 50);
        if (doc) {
            doc.client_id = null;
            doc.client_snapshot = JSON.stringify({ name: 'Jeanne Martin', siret: '' });
        }

        const { copy } = await docExport.handler(ctxOf(store), { id: 50 });

        assert.equal(copy.client?.name, 'Jeanne Martin');
        assert.equal(copy.client?.kind, 'person');
    });
});
