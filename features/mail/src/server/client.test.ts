import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { MailOAuthCredentials } from './client';

/**
 * La résolution de l'authentification d'une boîte OAuth, au moment où son jeton
 * d'accès arrive à terme. Ce qui se joue ici est la conduite à tenir : seul un
 * refus définitif du fournisseur est une impasse dont il faut sortir par une
 * reconnexion, tout le reste est un incident qui se rattrape au tour suivant.
 *
 * `OAUTH_GOOGLE_*` est posé AVANT le chargement du module, `env.ts` lisant
 * l'environnement à l'import : c'est la raison de l'import dynamique.
 */

process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client';
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret';
const { resolveAuth, MailReauthRequiredError } = await import('./client');
const { OAuthTokenError } = await import('./oauth');

/** Une boîte Google dont le jeton d'accès est déjà hors délai. */
function expiredAccount(overrides: Partial<MailOAuthCredentials> = {}): MailOAuthCredentials {
    return {
        kind: 'oauth',
        provider: 'google',
        email: 'boite@exemple.com',
        accessToken: 'stale',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
        proxy: null,
        ...overrides
    };
}

function answers(body: string, status = 200): void {
    mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
}

afterEach(() => mock.restoreAll());

describe('resolveAuth : le renouvellement du jeton', () => {
    it('un refus définitif est une impasse : reconnexion requise, rien n’est persisté', async () => {
        answers('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', 400);
        let persisted = 0;
        const e = await resolveAuth(expiredAccount(), async () => void persisted++).then(
            () => null,
            (err: unknown) => err
        );
        assert.ok(e instanceof MailReauthRequiredError);
        assert.ok(e.cause instanceof OAuthTokenError);
        assert.equal(persisted, 0);
    });

    it('un incident passager ressort tel quel : l’annoncer « reconnectez-le » enverrait défaire ce qui marche', async () => {
        answers('{"error":"backend_error"}', 503);
        const e = await resolveAuth(expiredAccount()).then(
            () => null,
            (err: unknown) => err
        );
        assert.ok(e instanceof OAuthTokenError);
        assert.ok(!(e instanceof MailReauthRequiredError));
    });

    it('plus de jeton de rafraîchissement du tout : une impasse, et dite comme telle', async () => {
        const e = await resolveAuth(expiredAccount({ refreshToken: null })).then(
            () => null,
            (err: unknown) => err
        );
        assert.ok(e instanceof MailReauthRequiredError);
    });

    it('un renouvellement réussi rend le jeton neuf et le signale une fois', async () => {
        answers('{"access_token":"fresh","expires_in":3600}');
        const seen: string[] = [];
        const auth = await resolveAuth(expiredAccount(), async ({ accessToken }) => void seen.push(accessToken));
        assert.deepEqual(seen, ['fresh']);
        assert.equal(auth.imapAuth.accessToken, 'fresh');
        assert.equal(auth.smtpAuth.type === 'OAuth2' && auth.smtpAuth.accessToken, 'fresh');
    });

    it('un jeton encore valide ne déclenche aucun appel', async () => {
        const fetched = mock.method(globalThis, 'fetch', async () => new Response('{}'));
        const auth = await resolveAuth(expiredAccount({ expiresAt: Date.now() + 3_600_000 }));
        assert.equal(fetched.mock.callCount(), 0);
        assert.equal(auth.imapAuth.accessToken, 'stale');
    });
});
