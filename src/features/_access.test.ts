import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerModules } from './_sdk/register';
import { grantsFor } from './_access';

/**
 * Le grant du propriétaire couvre AUSSI les modules installés.
 *
 * La régression que ce test verrouille : « tout » était bâti sur l'enum natif
 * seul, donc le propriétaire recevait `forbidden` sur chaque commande d'un
 * module à id externe — dans son propre espace personnel. Aucune autre
 * sentinelle ne le voyait : les ids natifs rapatriés (weather, osint,
 * cloudsync) sont dans l'enum, et le premier module `x-…` réellement exercé
 * (Countdown, le template) a traversé typechecks, tests et boot avant de
 * tomber sur le refus.
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
