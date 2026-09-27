import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountExportProblem } from '@deveye/types/sdk/server';

import { serverEntry } from './index';

describe('export du compte', () => {
    it('déclare un sort valide pour chaque table', () => {
        assert.ok(serverEntry.accountExport, 'le module déclare son export');
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });
});
