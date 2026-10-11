import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { featureHandlerMap } from './registry';

describe('featureHandlerMap', () => {
    it("ne trouve aucune commande dans le prototype d'un objet", () => {
        for (const command of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            assert.equal(featureHandlerMap.get(command), undefined, command);
        }
    });

    it('trouve une commande déclarée', () => {
        assert.equal(featureHandlerMap.get('workspace.roleList')?.command, 'workspace.roleList');
    });
});
