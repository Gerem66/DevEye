import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerModules } from './_sdk/register';
import { grantsFor } from './_access';

/**
 * Le grant du propriétaire couvre aussi les modules installés : bâti sur l'enum
 * natif seul, il refusait au propriétaire chaque commande d'un module à id
 * externe.
 */

// Un module externe minimal, enregistré comme la glue générée le ferait.
// `registerModules` valide le manifest : tout champ obligatoire y est.
registerModules([
    {
        manifest: {
            id: 'x-testfeature',
            label: 'Test',
            description: 'Module de test du grant propriétaire.',
            // La validation exige un champ non vide, pas une icône existante :
            // valeur volontairement factice, rien ne se rend dans un test.
            icon: 'test',
            category: 'daily',
            notifies: false,
            hasItems: false,
            shareTier: 'never',
            resources: [],
            commands: []
        },
        server: { features: [] }
    }
]);

describe('grantsFor — propriétaire', () => {
    it('accorde write sur un module externe installé, comme sur une native', () => {
        const { features, channels } = grantsFor(true, null);
        assert.equal(features.get('x-testfeature'), 'write');
        assert.equal(features.get('notes'), 'write');
        assert.ok(channels.has('x-testfeature'));
    });

    it("n'accorde rien à un membre sans rôle, module ou pas", () => {
        const { features } = grantsFor(false, null);
        assert.equal(features.size, 0);
    });
});
