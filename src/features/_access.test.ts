import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerModules } from './_sdk/register';
import { assertDeclaredRole, grantsFor } from './_access';
import { adminFeatureStatsFeature } from './admin/featureStats';
import { adminPendingFeature } from './admin/pending';
import { feedbackDeleteFeature, feedbackListFeature, feedbackSetStatusFeature } from './feedback';

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

describe('les gardes de rôle global, au dispatcheur', () => {
    const user = { isAdmin: false, canModerate: false };
    const moderator = { isAdmin: false, canModerate: true };
    const admin = { isAdmin: true, canModerate: true };
    const forbidden = { name: 'FeatureError', code: 'forbidden' };

    it('moderation : un modérateur ou un administrateur, jamais un utilisateur', () => {
        assert.throws(() => assertDeclaredRole({ moderation: true }, user), {
            ...forbidden,
            message: 'Réservé à la modération'
        });
        assert.doesNotThrow(() => assertDeclaredRole({ moderation: true }, moderator));
        assert.doesNotThrow(() => assertDeclaredRole({ moderation: true }, admin));
    });

    it("admin : l'administrateur seul, le modérateur compris parmi les refusés", () => {
        assert.throws(() => assertDeclaredRole({ admin: true }, moderator), forbidden);
        assert.doesNotThrow(() => assertDeclaredRole({ admin: true }, admin));
        assert.doesNotThrow(() => assertDeclaredRole(undefined, user));
    });

    it('les retours et les badges se gardent par la modération, les chiffres globaux par l’administration', () => {
        for (const def of [feedbackListFeature, feedbackSetStatusFeature, feedbackDeleteFeature, adminPendingFeature]) {
            assert.deepEqual(def.access, { moderation: true, scope: 'account' }, def.command);
            assert.throws(() => assertDeclaredRole(def.access, user), forbidden, def.command);
            assert.doesNotThrow(() => assertDeclaredRole(def.access, moderator), def.command);
        }
        assert.throws(() => assertDeclaredRole(adminFeatureStatsFeature.access, moderator), forbidden);
        assert.doesNotThrow(() => assertDeclaredRole(adminFeatureStatsFeature.access, admin));
    });
});
