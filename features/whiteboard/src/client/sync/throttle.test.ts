import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { throttle } from './throttle';

describe('throttle', () => {
    it('regroupe les demandes et garde la dernière', () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            let calls = 0;
            const t = throttle(() => calls++, 100);
            t.schedule();
            t.schedule();
            mock.timers.tick(0);
            assert.equal(calls, 1);
            t.schedule();
            mock.timers.tick(50);
            assert.equal(calls, 1);
            mock.timers.tick(60);
            assert.equal(calls, 2);
        } finally {
            mock.timers.reset();
        }
    });

    it('flush part tout de suite, cancel oublie', () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        try {
            let calls = 0;
            const t = throttle(() => calls++, 100);
            t.schedule();
            mock.timers.tick(0);
            t.schedule();
            t.flush();
            assert.equal(calls, 2);
            t.schedule();
            t.cancel();
            mock.timers.tick(500);
            assert.equal(calls, 2);
        } finally {
            mock.timers.reset();
        }
    });
});
