import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { addDays, todayIn } from '../contracts/calendar';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { createService } from './service';

const DAY = todayIn('UTC');

/** Le service, avec sa boucle capturée plutôt que lancée. */
function mount(store: MemoryStore) {
    const deps = createTestServiceDeps({ repo: memoryRepo(store) });
    const service = createService(deps);
    const tick = deps.recorded.tickers[0]?.tick;
    assert.ok(tick, 'le service déclare bien une boucle');
    return { deps, service, tick };
}

describe('les relances', () => {
    it('prévient l’espace pour une facture échue et non soldée', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: addDays(DAY, -9), total_gross: 120_000, number_label: 'F-0007' }));
        const { deps, tick } = mount(store);

        await tick();

        assert.equal(deps.recorded.notifications.length, 1);
        const alert = deps.recorded.notifications[0];
        assert.ok(alert.subject.includes('F-0007'));
        assert.ok(alert.body.includes('retard de 9 jours'));
        assert.ok(store.docs[0].reminded_at !== null, 'la relance est marquée');
    });

    it('ne redit pas la même chose au tour suivant', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: addDays(DAY, -9), total_gross: 120_000 }));
        const { deps, tick } = mount(store);

        await tick();
        await tick();

        assert.equal(deps.recorded.notifications.length, 1);
    });

    it('laisse tranquille ce qui est à jour, soldé, ou encore en brouillon', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: addDays(DAY, 10) }));
        store.docs.push(docRow({ id: 11, due_on: addDays(DAY, -10), total_gross: 120_000 }));
        store.payments.push({ doc_id: 11, workspace_id: 1, amount: 120_000, paid_on: DAY });
        store.docs.push(docRow({ id: 12, status: 'draft', due_on: addDays(DAY, -10), total_gross: null }));
        store.docs.push(docRow({ id: 13, kind: 'quote', status: 'sent', due_on: addDays(DAY, -10) }));
        const { deps, tick } = mount(store);

        await tick();

        assert.equal(deps.recorded.notifications.length, 0);
    });

    it('marque la relance même quand aucun canal n’accepte', async () => {
        const store = emptyStore();
        store.docs.push(docRow({ id: 10, due_on: addDays(DAY, -9), total_gross: 120_000 }));
        const deps = createTestServiceDeps({ repo: memoryRepo(store), notifyAccepted: false });
        createService(deps);
        await deps.recorded.tickers[0].tick();

        assert.ok(store.docs[0].reminded_at !== null);
    });
});
