import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTracking } from './tracking';
import type { Store } from './store';

function memoryStore(): Pick<Store, 'meta' | 'setMeta'> {
    const held = new Map<string, string>();
    return {
        meta: (key) => held.get(key) ?? null,
        setMeta: (key, value) => void held.set(key, value)
    };
}

describe('la balise de la page d’état', () => {
    it('rien tant que DevEye n’a rien dit, puis ce qu’il a dit, origine ramenée à son hôte', async () => {
        const store = memoryStore();
        let answer: unknown = { tracking: { key: 'pk_abc', origin: 'https://api.deveye.fr/t.js' } };
        const tracking = createTracking({ store: store as Store, fetchTracking: async () => answer });
        assert.equal(tracking.current(), null);
        await tracking.refresh();
        assert.deepEqual(tracking.current(), { key: 'pk_abc', origin: 'https://api.deveye.fr' });

        answer = { tracking: null };
        await tracking.refresh();
        assert.equal(tracking.current(), null);
    });

    it('une réponse illisible ou une panne laissent la balise connue', async () => {
        const store = memoryStore();
        const answers: unknown[] = [{ tracking: { key: 'pk_abc', origin: 'https://api.deveye.fr' } }, { nope: 1 }];
        const tracking = createTracking({
            store: store as Store,
            fetchTracking: async () => {
                if (answers.length === 0) throw new Error('HTTP 502');
                return answers.shift();
            }
        });
        await tracking.refresh();
        await tracking.refresh();
        await tracking.refresh();
        assert.deepEqual(tracking.current(), { key: 'pk_abc', origin: 'https://api.deveye.fr' });
    });
});
