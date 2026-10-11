import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeQueryable } from '../pool.fake';
import { roleOf, usersRepo } from './users';

/** Le rôle global se lit tel quel : un modérateur ne retombe jamais au rang d'utilisateur. */

describe('le rôle d’un compte', () => {
    it('garde les trois rôles, et une valeur inconnue vaut le rôle sans privilège', () => {
        assert.equal(roleOf('user'), 'user');
        assert.equal(roleOf('moderator'), 'moderator');
        assert.equal(roleOf('admin'), 'admin');
        assert.equal(roleOf('superadmin'), 'user');
        assert.equal(roleOf(''), 'user');
    });

    it('la page Utilisateurs montre le modérateur comme tel', async () => {
        const row = {
            id: 2,
            username: 'mo',
            email: 'mo@exemple.fr',
            avatar: '',
            role: 'moderator',
            status: 'active',
            workspace_count: 1,
            last_login: 0,
            created: 0,
            e2e_run: null
        };
        const [user] = await usersRepo(fakeQueryable(() => [row])).listForAdmin();
        assert.equal(user?.role, 'moderator');
    });

    it('les comptes qui modèrent : modérateurs et administrateurs actifs, avec leur espace personnel', async () => {
        const q = fakeQueryable(() => [{ id: 3, personal_workspace_id: 30 }]);
        assert.deepEqual(await usersRepo(q).listModeratorIds(), [{ id: 3, personalWorkspaceId: 30 }]);
        assert.match(q.queries[0]!.sql, /role IN \('moderator', 'admin'\) AND status = 'active'/);
    });
});
