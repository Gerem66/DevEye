import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeltaTracker } from './delta';
import { gate } from './seqGate';

describe('DeltaTracker', () => {
    it('envoie ce qui est plus récent, une seule fois tant que l’envoi est en route', () => {
        const t = new DeltaTracker();
        t.reset([{ id: 'a', version: 2 }]);
        const els = [
            { id: 'a', version: 2 },
            { id: 'b', version: 1 },
            { id: 'a2', version: 3 }
        ];
        const first = t.diff(els, 10);
        assert.deepEqual(
            first.map((e) => e.id),
            ['b', 'a2']
        );
        t.sending(first);
        assert.deepEqual(t.diff(els, 10), []);
    });

    it('un envoi échoué repart, un envoi abouti non', () => {
        const t = new DeltaTracker();
        const els = [{ id: 'a', version: 1 }];
        t.sending(t.diff(els, 10));
        t.failed(els);
        assert.equal(t.diff(els, 10).length, 1);
        t.sending(els);
        t.sent(els);
        assert.equal(t.diff(els, 10).length, 0);
        assert.equal(t.diff([{ id: 'a', version: 2 }], 10).length, 1);
    });

    it('ce qui vient des autres ne repart pas', () => {
        const t = new DeltaTracker();
        t.received([{ id: 'x', version: 5 }]);
        assert.deepEqual(t.diff([{ id: 'x', version: 5 }], 10), []);
    });

    it('borne le nombre d’éléments par envoi', () => {
        const t = new DeltaTracker();
        const els = Array.from({ length: 7 }, (_, i) => ({ id: String(i), version: 1 }));
        assert.equal(t.diff(els, 3).length, 3);
    });
});

describe('gate', () => {
    it('applique la suivante, ignore la vue, signale le trou', () => {
        assert.equal(gate(4, 5), 'apply');
        assert.equal(gate(4, 4), 'stale');
        assert.equal(gate(4, 2), 'stale');
        assert.equal(gate(4, 7), 'gap');
    });
});
