import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advance, FAILURE_STREAK, inherit, UNKNOWN, type Observation, type Tracked } from './state';

const seen = (state: Observation['state'], reason: string | null = null): Observation => ({
    state,
    reason,
    message: null
});

function run(start: Tracked, steps: Observation[]): { tracked: Tracked; transitions: number } {
    let tracked = start;
    let transitions = 0;
    steps.forEach((s, i) => {
        const r = advance(tracked, s, 100 + i * 60);
        tracked = r.next;
        if (r.transition) transitions++;
    });
    return { tracked, transitions };
}

describe('advance', () => {
    it('un succès s’applique aussitôt', () => {
        const { next, transition } = advance(UNKNOWN, seen('up'), 100);
        assert.equal(next.state, 'up');
        assert.deepEqual(transition, { from: null, to: 'up', at: 100, inherited: false });
    });

    it('une panne attend sa confirmation, puis se date de la première mesure', () => {
        const up = advance(UNKNOWN, seen('up'), 0).next;
        const first = advance(up, seen('down', 'Ne répond pas'), 100);
        assert.equal(first.next.state, 'up');
        assert.equal(first.transition, null);
        const second = advance(first.next, seen('down', 'Ne répond pas'), 160);
        assert.equal(FAILURE_STREAK, 2);
        assert.equal(second.next.state, 'down');
        assert.equal(second.next.since, 100);
        assert.equal(second.next.reason, 'Ne répond pas');
    });

    it('un raté isolé ne laisse rien', () => {
        const up = advance(UNKNOWN, seen('up'), 0).next;
        const { tracked, transitions } = run(up, [seen('down'), seen('up'), seen('down'), seen('up')]);
        assert.equal(tracked.state, 'up');
        assert.equal(transitions, 0);
    });

    it('la maintenance s’applique aussitôt', () => {
        const up = advance(UNKNOWN, seen('up'), 0).next;
        assert.equal(advance(up, seen('maintenance'), 60).next.state, 'maintenance');
    });

    it('une amélioration s’applique aussitôt, une aggravation attend', () => {
        const down = run(UNKNOWN, [seen('down'), seen('down')]).tracked;
        assert.equal(down.state, 'down');
        assert.equal(advance(down, seen('degraded'), 500).next.state, 'degraded');
        const degraded = advance(down, seen('degraded'), 500).next;
        assert.equal(advance(degraded, seen('down'), 560).next.state, 'degraded');
    });
});

describe('inherit', () => {
    it('l’app revenue, l’état hérité ne reste pas affiché pendant qu’une panne propre se confirme', () => {
        const held = inherit(advance(UNKNOWN, seen('up'), 0).next, seen('maintenance'), 60).next;
        const first = advance(held, seen('down'), 120);
        assert.equal(first.next.state, null);
        assert.equal(first.next.inherited, false);
        assert.equal(first.transition, null);
        assert.equal(advance(first.next, seen('down'), 180).next.state, 'down');
    });

    it('l’état de l’app s’impose sans attendre, puis la mesure propre reprend', () => {
        const up = advance(UNKNOWN, seen('up'), 0).next;
        const held = inherit(up, seen('maintenance'), 60);
        assert.equal(held.next.state, 'maintenance');
        assert.equal(held.next.inherited, true);
        assert.equal(held.transition?.inherited, true);
        assert.equal(inherit(held.next, seen('maintenance'), 120).transition, null);
        const back = advance(held.next, seen('up'), 180);
        assert.equal(back.next.state, 'up');
        assert.equal(back.next.inherited, false);
    });
});
