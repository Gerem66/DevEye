import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServerMessage } from '@deveye/types';
import { progressLane } from './progress';

function lane() {
    const frames: ServerMessage[] = [];
    let clock = 1_000;
    const l = progressLane(
        'req-1',
        (m) => frames.push(m),
        () => clock
    );
    return { l, frames, advance: (ms: number) => (clock += ms) };
}

const data = (m: ServerMessage | undefined) => (m?.payload.ok ? m.payload.data : null);

describe('progressLane', () => {
    it('envoie la première trame aussitôt, avec la requête', () => {
        const { l, frames } = lane();
        l.report({ done: 1, total: 10 });
        assert.equal(frames.length, 1);
        assert.equal(frames[0]?.command, 'request.progress');
        assert.deepEqual(data(frames[0]), { requestId: 'req-1', done: 1, total: 10, step: undefined });
        l.close();
    });

    it('retient les trames rapprochées et envoie la dernière', async () => {
        const { l, frames, advance } = lane();
        l.report({ done: 1, total: 10 });
        l.report({ done: 2, total: 10 });
        l.report({ done: 3, total: 10 });
        assert.equal(frames.length, 1);
        advance(250);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(frames.length, 2);
        assert.equal((data(frames[1]) as { done: number }).done, 3);
        l.close();
    });

    it('ne parle plus une fois fermée', async () => {
        const { l, frames } = lane();
        l.report({ step: 'a' });
        l.report({ step: 'b' });
        l.close();
        l.report({ step: 'c' });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(frames.length, 1);
    });
});
