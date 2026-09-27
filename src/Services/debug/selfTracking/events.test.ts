import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authEvent, commandEvent, excluded, failureEvent, isStaticPath } from './events';

describe('le suivi d’usage', () => {
    it('une page se nomme par un chemin statique, jamais par un identifiant', () => {
        assert.equal(isStaticPath('/home'), true);
        assert.equal(isStaticPath('/settings/uptime/notifications'), true);
        assert.equal(isStaticPath('/account/x-billing'), true);
        assert.equal(isStaticPath('/projects/1234'), false);
        assert.equal(isStaticPath('/Notes'), false);
        assert.equal(isStaticPath('/notes/ma note'), false);
        assert.equal(isStaticPath('home'), false);
        assert.equal(isStaticPath(`/${'a'.repeat(130)}`), false);
    });

    it('une action par sa commande, sur la page de sa fonctionnalité ; un refus avec son code', () => {
        assert.deepEqual(commandEvent('uptime.add'), { type: 'event', name: 'uptime.add', path: '/uptime' });
        assert.deepEqual(failureEvent('x-rdv.typeAdd', 'quota_exceeded'), {
            type: 'event',
            name: 'x-rdv.typeAdd (quota_exceeded)',
            path: '/x-rdv'
        });
    });

    it('les routes d’authentification, réussies ou refusées ; les autres n’existent pas', () => {
        assert.deepEqual(authEvent('/api/auth/login', 200), { type: 'event', name: 'auth.login', path: '/auth' });
        assert.equal(authEvent('/api/auth/login', 401)?.name, 'auth.login (auth_invalid)');
        assert.equal(authEvent('/api/auth/signup', 502)?.name, 'auth.signup (internal)');
        assert.equal(authEvent('/api/auth/me', 200), null);
    });

    it('le trafic d’un essai et les comptes d’essai ne comptent jamais ; un administrateur selon le réglage', () => {
        const admin = { role: 'admin', e2eRun: null };
        const probe = { role: 'user', e2eRun: 'abcdef-12345678' };
        assert.equal(excluded(null, { excludeAdmins: true }, true), true);
        assert.equal(excluded(probe, { excludeAdmins: false }, false), true);
        assert.equal(excluded(admin, { excludeAdmins: true }, false), true);
        assert.equal(excluded(admin, { excludeAdmins: false }, false), false);
        assert.equal(excluded(null, { excludeAdmins: true }, false), false);
    });
});
