import assert from 'node:assert/strict';
import { it } from 'node:test';

import { accountExportProblem } from '@deveye/types/sdk/server';

import { serverEntry } from './index';

it('donne un sort valable à chaque table dans l’export du compte', () => {
    assert.ok(serverEntry.accountExport);
    assert.equal(accountExportProblem(serverEntry.accountExport), null);
});
