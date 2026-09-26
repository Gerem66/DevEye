import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INVOICING_LEDGER_PROVIDER, type InvoicingLedgerProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { addDays, todayIn } from '../contracts/calendar';
import { docSegment } from '../contracts/domain';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { createService } from './service';

/**
 * Ce que Finances lit de Facturation. Deux promesses surtout : la version bouge
 * à chaque règlement ajouté ou retiré, et la taxe de chaque règlement tombe
 * juste au centime avec celle du tableau de bord.
 */

const DAY = todayIn('Europe/Paris');

function mount(store: MemoryStore): { ledger: InvoicingLedgerProvider; store: MemoryStore } {
    const service = createService(createTestServiceDeps({ repo: memoryRepo(store) }));
    const ledger = service.providers?.[INVOICING_LEDGER_PROVIDER] as InvoicingLedgerProvider | undefined;
    assert.ok(ledger, 'Facturation offre bien le fournisseur');
    return { ledger, store };
}

function pay(store: MemoryStore, docId: number, amount: number, paidOn = DAY): number {
    const id = store.nextId++;
    store.payments.push({ id, doc_id: docId, workspace_id: 1, amount, paid_on: paidOn, method: 'transfer' });
    return id;
}

const SNAPSHOT = JSON.stringify({ name: 'Dupont SARL' });

describe('le livre de Facturation, vu par Finances', () => {
    it('change de version à chaque règlement ajouté ou retiré', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(docRow({ id: 10 }));

        const empty = await ledger.version(1);
        const first = pay(store, 10, 40_000);
        const one = await ledger.version(1);
        assert.notEqual(one, empty);

        store.payments.splice(
            store.payments.findIndex((p) => p.id === first),
            1
        );
        pay(store, 10, 40_000);
        // Même nombre de règlements qu'avant, mais un autre : la version le voit.
        assert.notEqual(await ledger.version(1), one);
    });

    it('rend chaque règlement avec sa part de taxe, dont la somme est celle du tableau de bord', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(docRow({ id: 10, total_net: 100_000, total_vat: 20_000, total_gross: 120_000 }));
        pay(store, 10, 40_000);
        pay(store, 10, 40_000);
        pay(store, 10, 40_000);

        const payments = await ledger.payments(1, null);
        assert.equal(payments.length, 3);
        assert.equal(payments[0].segment, docSegment(10));
        const vat = payments.reduce((sum, p) => sum + p.vatCents, 0);
        const cashed = await memoryRepo(store).cashedBetween(1, addDays(DAY, -1), addDays(DAY, 1));
        assert.equal(vat, cashed.vatCents);
    });

    it('ne rend que les règlements depuis la date demandée', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(docRow({ id: 10 }));
        pay(store, 10, 10_000, addDays(DAY, -40));
        pay(store, 10, 10_000, DAY);

        assert.equal((await ledger.payments(1, addDays(DAY, -10))).length, 1);
        assert.equal((await ledger.payments(1, null)).length, 2);
    });

    it('rend ce qui reste dû, retard et client compris', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(
            docRow({ id: 10, due_on: addDays(DAY, -5), client_snapshot: SNAPSHOT }),
            docRow({ id: 11, number: 2, number_label: 'F-0002', due_on: addDays(DAY, 20) }),
            docRow({ id: 12, number: 3, status: 'draft', total_gross: null, total_vat: null, total_net: null })
        );
        pay(store, 10, 20_000);

        const due = await ledger.receivables(1);
        assert.deepEqual(
            due.map((r) => r.docId),
            [10, 11],
            'le brouillon ne doit rien, et le plus ancien vient d’abord'
        );
        assert.equal(due[0].remainingCents, 100_000);
        assert.equal(due[0].overdue, true);
        assert.equal(due[0].clientName, 'Dupont SARL');
        assert.equal(due[1].overdue, false);
    });

    it('ne rend plus une facture soldée', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(docRow({ id: 10 }));
        pay(store, 10, 120_000);
        assert.equal((await ledger.receivables(1)).length, 0);
    });

    it('lit les noms des clients figés sur les factures', async () => {
        const { ledger, store } = mount(emptyStore());
        store.docs.push(docRow({ id: 10, client_snapshot: SNAPSHOT }), docRow({ id: 11 }));
        const names = await ledger.clientNames(1, [10, 11]);
        assert.equal(names.get(10), 'Dupont SARL');
        assert.equal(names.has(11), false);
    });
});
