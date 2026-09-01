import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertAccessDeclared } from './_permissions';

/**
 * Le contrôle de démarrage : ce qu'il attrape, et ce qu'il laisse passer. Une
 * commande gardée par rien, ou une permission propre qui ne vise aucune
 * fonctionnalité, doit coûter le démarrage plutôt qu'ouvrir en silence.
 */
describe('assertAccessDeclared', () => {
    it('refuse une commande sans autorisation déclarée', () => {
        assert.throws(() => assertAccessDeclared([{ command: 'x.nue' }]), /x\.nue/);
    });

    it('laisse passer une commande exemptée', () => {
        assert.doesNotThrow(() => assertAccessDeclared([{ command: 'workspace.roleList' }]));
    });

    it('refuse une permission propre qui ne vise aucune fonctionnalité', () => {
        assert.throws(
            () => assertAccessDeclared([{ command: 'agent.termOpen', access: { extras: ['terminal'] } }]),
            /agent\.termOpen/
        );
    });

    it('accepte la même, rattachée à sa fonctionnalité', () => {
        assert.doesNotThrow(() =>
            assertAccessDeclared([{ command: 'agent.termOpen', access: { feature: 'devices', extras: ['terminal'] } }])
        );
    });
});
