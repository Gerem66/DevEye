import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportQueryable } from './run';

describe('exportQueryable', () => {
    it('rend une colonne DATE en date de calendrier, et laisse le reste', async () => {
        const instant = new Date(2026, 2, 15, 10, 30);
        const q = exportQueryable({
            query: async <T extends object>() => [{ day: new Date(2026, 2, 15), at: instant, n: 3, s: 'x' }] as T[],
            execute: async () => ({ affectedRows: 0, insertId: 0 })
        });
        assert.deepEqual(await q.query('SELECT 1'), [{ day: '2026-03-15', at: instant, n: 3, s: 'x' }]);
    });
});
