import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import type { InvoicingClientInput } from '../contracts/domain';
import { addDays, todayIn } from '../contracts/calendar';
import { docRow, emptyStore, memoryRepo, type MemoryDoc, type MemoryStore } from './_memoryRepo';
import { clientList, clientRemove, clientSave } from './handlers/clients';

function input(over: Partial<InvoicingClientInput> = {}): InvoicingClientInput {
    return {
        kind: 'company',
        name: 'Atelier Martin',
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
        defaultVatBp: null,
        ...over
    };
}

const DAY = todayIn('Europe/Paris');
const doc = (over: Partial<MemoryDoc> = {}) => docRow(over);

function ctxOf(store: MemoryStore, over: Record<string, unknown> = {}) {
    return createTestContext({ repo: memoryRepo(store), workspaceId: 1, ...over });
}

describe('invoicing.clientSave', () => {
    it('crée un client et garde son identité hors des colonnes en clair', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);

        const res = await clientSave.handler(ctx, {
            id: null,
            client: input({ name: 'Atelier Martin', siret: '81234567800017', email: 'martin@exemple.fr' }),
            archived: false
        });

        assert.equal(res.client.name, 'Atelier Martin');
        assert.equal(res.client.siret, '81234567800017');
        assert.equal(res.client.archived, false);

        const row = store.clients.get(res.client.id);
        assert.ok(row);
        const clear = JSON.stringify({ ...row, content: '' });
        assert.ok(!clear.includes('Martin'), 'le nom ne vit pas en clair');
        assert.ok(!clear.includes('81234567800017'), 'le SIRET ne vit pas en clair');
        assert.ok(row.content.includes('Atelier Martin'));
    });

    it('garde en clair ce sur quoi le serveur décide', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const res = await clientSave.handler(ctx, {
            id: null,
            client: input({ kind: 'person', paymentTermsDays: 45, defaultVatBp: 550 }),
            archived: true
        });

        const row = store.clients.get(res.client.id);
        assert.equal(row?.kind, 'person');
        assert.equal(row?.payment_terms_days, 45);
        assert.equal(row?.default_vat_bp, 550);
        assert.equal(row?.archived, 1);
    });

    it('corrige un client existant', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await clientSave.handler(ctx, { id: null, client: input(), archived: false });

        const res = await clientSave.handler(ctx, {
            id: created.client.id,
            client: input({ name: 'Atelier Martin et fils', city: 'Lyon' }),
            archived: false
        });

        assert.equal(res.client.id, created.client.id);
        assert.equal(res.client.name, 'Atelier Martin et fils');
        assert.equal(res.client.city, 'Lyon');
        assert.equal(store.clients.size, 1);
    });

    it('ne corrige pas le client d’un autre espace', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        await assert.rejects(
            () => clientSave.handler(ctx, { id: 999, client: input(), archived: false }),
            (error: unknown) => error instanceof FeatureError && error.code === 'not_found'
        );
    });

    it('refuse la correction d’un client que le rôle ne laisse qu’en lecture', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await clientSave.handler(ctx, { id: null, client: input(), archived: false });

        const limited = ctxOf(store, { itemRestrictions: { [String(created.client.id)]: 'read' } });
        await assert.rejects(
            () =>
                clientSave.handler(limited, {
                    id: created.client.id,
                    client: input({ name: 'Renommé' }),
                    archived: false
                }),
            (error: unknown) => error instanceof FeatureError && error.code === 'forbidden'
        );
    });
});

describe('invoicing.clientList', () => {
    it('trie par nom, après descellement', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        for (const name of ['Zèbre', 'Atelier', 'Épicerie']) {
            await clientSave.handler(ctx, { id: null, client: input({ name }), archived: false });
        }

        const res = await clientList.handler(ctx, { archived: false });
        assert.deepEqual(
            res.clients.map((c) => c.name),
            ['Atelier', 'Épicerie', 'Zèbre']
        );
    });

    it('laisse les clients mis de côté hors de la liste, sauf demande', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        await clientSave.handler(ctx, { id: null, client: input({ name: 'Actif' }), archived: false });
        await clientSave.handler(ctx, { id: null, client: input({ name: 'Rangé' }), archived: true });

        assert.equal((await clientList.handler(ctx, { archived: false })).clients.length, 1);
        assert.equal((await clientList.handler(ctx, { archived: true })).clients.length, 2);
    });

    it('cache un client qu’un rôle a fermé', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const hidden = await clientSave.handler(ctx, { id: null, client: input({ name: 'Fermé' }), archived: false });
        await clientSave.handler(ctx, { id: null, client: input({ name: 'Ouvert' }), archived: false });

        const limited = ctxOf(store, { itemRestrictions: { [String(hidden.client.id)]: 'none' } });
        const res = await clientList.handler(limited, { archived: false });
        assert.deepEqual(
            res.clients.map((c) => c.name),
            ['Ouvert']
        );
    });

    it('dit ce que chaque client représente', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const client = await clientSave.handler(ctx, { id: null, client: input(), archived: false });
        const id = client.client.id;

        store.docs.push(doc({ id: 10, client_id: id, total_gross: 120_000, due_on: addDays(DAY, 30) }));
        store.docs.push(doc({ id: 11, client_id: id, total_gross: 60_000, due_on: addDays(DAY, -30) }));
        store.payments.push({ doc_id: 10, workspace_id: 1, amount: 20_000, paid_on: DAY });

        const res = await clientList.handler(ctx, { archived: false });
        const usage = res.clients[0].usage;

        assert.equal(usage.documents, 2);
        assert.equal(usage.billedCents, 180_000);
        assert.equal(usage.outstandingCents, 100_000 + 60_000);
        assert.equal(usage.overdueCents, 60_000, 'seule la facture échue est en retard');
        assert.equal(usage.lastIssuedOn, DAY);
    });
});

describe('invoicing.clientRemove', () => {
    it('retire un client sans document, et l’oublie', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await clientSave.handler(ctx, { id: null, client: input(), archived: false });

        await clientRemove.handler(ctx, { id: created.client.id });

        assert.equal(store.clients.size, 0);
        assert.deepEqual(ctx.forgotten, [String(created.client.id)]);
    });

    it('refuse de retirer un client que des documents portent, en les comptant', async () => {
        const store = emptyStore();
        const ctx = ctxOf(store);
        const created = await clientSave.handler(ctx, { id: null, client: input(), archived: false });
        store.docs.push(doc({ id: 10, client_id: created.client.id }));
        store.docs.push(doc({ id: 11, client_id: created.client.id }));

        await assert.rejects(
            () => clientRemove.handler(ctx, { id: created.client.id }),
            (error: unknown) =>
                error instanceof FeatureError && error.code === 'conflict' && error.message.includes('2 documents')
        );
        assert.equal(store.clients.size, 1, 'rien n’est retiré');
        assert.deepEqual(ctx.forgotten, [], 'et rien n’est oublié');
    });

    it('ne retire pas le client d’un autre espace', async () => {
        const ctx = ctxOf(emptyStore());
        await assert.rejects(
            () => clientRemove.handler(ctx, { id: 999 }),
            (error: unknown) => error instanceof FeatureError && error.code === 'not_found'
        );
    });
});
