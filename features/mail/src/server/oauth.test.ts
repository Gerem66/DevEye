import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/**
 * Le dialogue avec le point de jetons, sans réseau : ce qu'on tient pour un
 * refus définitif, ce qu'on tient pour un incident passager, et ce que
 * l'échéance vaut quand le fournisseur ne la dit pas. La distinction est tout
 * l'enjeu : un incident passager annoncé « reconnectez-le » envoie défaire une
 * boîte qui marche.
 *
 * `OAUTH_GOOGLE_*` est posé AVANT le chargement du module, `env.ts` lisant
 * l'environnement à l'import : c'est la raison de l'import dynamique.
 */

process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client';
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.OAUTH_MICROSOFT_CLIENT_ID = 'microsoft-client';
process.env.OAUTH_MICROSOFT_CLIENT_SECRET = 'microsoft-secret';
const { refreshAccessToken, OAuthTokenError } = await import('./oauth');

/** Une réponse du point de jetons, corps et statut au choix. */
function answers(body: string, status = 200): void {
    mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
}

function rejects(error: Error): void {
    mock.method(globalThis, 'fetch', async () => {
        throw error;
    });
}

async function refuses(): Promise<InstanceType<typeof OAuthTokenError>> {
    const e = await refreshAccessToken('google', 'refresh-token').then(
        () => null,
        (err: unknown) => err
    );
    assert.ok(e instanceof OAuthTokenError, `attendu OAuthTokenError, reçu ${String(e)}`);
    return e;
}

afterEach(() => mock.restoreAll());

describe('refreshAccessToken : le verdict sur un refus', () => {
    it('lit le code OAuth et non le statut : `invalid_grant` est définitif', async () => {
        answers('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', 400);
        const e = await refuses();
        assert.equal(e.permanent, true);
        assert.equal(e.code, 'invalid_grant');
        assert.equal(e.status, 400);
        assert.match(e.message, /Token has been expired or revoked/);
    });

    it('un plafond d’appels est passager, malgré le même statut 400', async () => {
        answers('{"error":"rate_limit_exceeded"}', 400);
        const e = await refuses();
        assert.equal(e.permanent, false);
        assert.equal(e.code, 'rate_limit_exceeded');
    });

    it('un 503 est passager : rien n’a été révoqué', async () => {
        answers('{"error":"backend_error"}', 503);
        const e = await refuses();
        assert.equal(e.permanent, false);
        assert.equal(e.status, 503);
    });

    it('une passerelle qui répond du HTML ne masque plus le refus derrière un SyntaxError', async () => {
        answers('<html><body>502 Bad Gateway</body></html>', 502);
        const e = await refuses();
        assert.equal(e.permanent, false);
        assert.equal(e.status, 502);
        assert.equal(e.code, null);
        assert.match(e.message, /Bad Gateway/);
    });

    it('un point de jetons injoignable garde le texte d’origine, pour que la lecture le reconnaisse', async () => {
        rejects(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'));
        const e = await refuses();
        assert.equal(e.permanent, false);
        assert.equal(e.status, null);
        assert.match(e.message, /ENOTFOUND/);
    });
});

describe('refreshAccessToken : l’échéance', () => {
    const cases: Array<[string, string]> = [
        ['absente', '{"access_token":"at"}'],
        ['nulle', '{"access_token":"at","expires_in":null}'],
        ['illisible', '{"access_token":"at","expires_in":"abc"}']
    ];

    for (const [label, body] of cases) {
        it(`${label} : repli sur une heure, jamais NaN (sans quoi le jeton ne se renouvelle plus jamais)`, async () => {
            answers(body);
            const { expiresAt } = await refreshAccessToken('google', 'refresh-token');
            assert.ok(Number.isFinite(expiresAt));
            assert.ok(expiresAt > Date.now() + 3_500_000 && expiresAt < Date.now() + 3_700_000);
        });
    }

    it('lue telle quelle quand le fournisseur la donne', async () => {
        answers('{"access_token":"at","expires_in":1800}');
        const { expiresAt } = await refreshAccessToken('google', 'refresh-token');
        assert.ok(expiresAt > Date.now() + 1_700_000 && expiresAt < Date.now() + 1_900_000);
    });
});

describe('refreshAccessToken : le jeton tournant et la coalescence', () => {
    it('remonte le jeton de rafraîchissement neuf quand le fournisseur en rend un', async () => {
        answers('{"access_token":"at","expires_in":3600,"refresh_token":"rotated"}');
        assert.equal((await refreshAccessToken('microsoft', 'old')).refreshToken, 'rotated');
    });

    it('rend null quand il n’y en a pas : l’ancien reste en place chez l’appelant', async () => {
        answers('{"access_token":"at","expires_in":3600}');
        assert.equal((await refreshAccessToken('google', 'refresh-token')).refreshToken, null);
    });

    it('deux demandes concurrentes sur le même jeton ne font qu’un appel', async () => {
        const fetched = mock.method(globalThis, 'fetch', async () => {
            await new Promise((r) => setTimeout(r, 10));
            return new Response('{"access_token":"at","expires_in":3600}');
        });
        const [a, b] = await Promise.all([
            refreshAccessToken('google', 'shared'),
            refreshAccessToken('google', 'shared')
        ]);
        assert.equal(fetched.mock.callCount(), 1);
        assert.equal(a.accessToken, b.accessToken);
    });

    it('l’entrée est purgée une fois retombée, échec compris', async () => {
        answers('{"error":"backend_error"}', 503);
        await refuses();
        mock.restoreAll();
        const fetched = mock.method(
            globalThis,
            'fetch',
            async () => new Response('{"access_token":"second","expires_in":3600}')
        );
        assert.equal((await refreshAccessToken('google', 'refresh-token')).accessToken, 'second');
        assert.equal(fetched.mock.callCount(), 1);
    });
});
