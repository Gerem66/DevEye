import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mailTree } from './copy';

/** Une copie passe par le navigateur de qui la fait : aucun secret ne voyage. */
describe('copie d’une boîte', () => {
    const redact = mailTree[0].redact!.credentials_enc;

    it('garde les serveurs d’une boîte à mot de passe, sans aucun mot de passe', () => {
        const endpoint = { host: 'imap.exemple.fr', port: 993, username: 'moi', password: 'secret' };
        const proxy = { kind: 'socks5', host: 'proxy.exemple.fr', port: 1080, username: 'p', password: 'secret' };
        const copy = JSON.parse(redact(JSON.stringify({ kind: 'password', imap: endpoint, smtp: endpoint, proxy })));
        assert.deepEqual(copy.imap, { ...endpoint, password: '' });
        assert.deepEqual(copy.smtp, { ...endpoint, password: '' });
        assert.deepEqual(copy.proxy, { ...proxy, password: null });
    });

    it('retire les jetons d’une boîte OAuth', () => {
        const copy = JSON.parse(
            redact(
                JSON.stringify({
                    kind: 'oauth',
                    provider: 'google',
                    email: 'moi@exemple.fr',
                    accessToken: 'jeton',
                    refreshToken: 'rafraîchissement',
                    expiresAt: 9_999_999_999_999,
                    proxy: null
                })
            )
        );
        assert.equal(copy.email, 'moi@exemple.fr');
        assert.equal(copy.accessToken, '');
        assert.equal(copy.refreshToken, null);
        assert.equal(copy.expiresAt, 0);
    });
});
