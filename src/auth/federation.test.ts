import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';

import { env } from '@/Utils/Env';
import {
    authTransport,
    federationEnabled,
    isFederatedOrigin,
    readAccessToken,
    setFederationOriginsForTest
} from './federation';

const request = (headers: Record<string, string>, cookies: Record<string, string> = {}): FastifyRequest =>
    ({ headers, cookies }) as unknown as FastifyRequest;

describe('federation', () => {
    afterEach(() => setFederationOriginsForTest(undefined));

    it('reste éteinte sans origine déclarée', () => {
        assert.equal(federationEnabled(), false);
        assert.equal(isFederatedOrigin('https://ailleurs.example'), false);
        assert.equal(authTransport(request({ origin: 'https://ailleurs.example' })), 'cookie');
    });

    it('ne reconnaît que les origines listées, barre finale ignorée', () => {
        setFederationOriginsForTest('https://a.example/, https://b.example:8443');
        assert.equal(federationEnabled(), true);
        assert.equal(isFederatedOrigin('https://a.example'), true);
        assert.equal(isFederatedOrigin('https://b.example:8443'), true);
        assert.equal(isFederatedOrigin('https://c.example'), false);
        assert.equal(isFederatedOrigin(undefined), false);
    });

    it('ne prend jamais notre propre origine pour une instance étrangère', () => {
        setFederationOriginsForTest(`*, ${env.PUBLIC_ORIGIN}`);
        assert.equal(isFederatedOrigin(env.PUBLIC_ORIGIN), false);
    });

    it('lit le jeton par le seul canal du transport', () => {
        setFederationOriginsForTest('https://a.example');
        const federated = request(
            { origin: 'https://a.example', authorization: 'Bearer porteur' },
            { dv_at: 'cookie' }
        );
        assert.equal(readAccessToken(federated), 'porteur');
        const own = request({ authorization: 'Bearer porteur' }, { dv_at: 'cookie' });
        assert.equal(readAccessToken(own), 'cookie');
        assert.equal(readAccessToken(request({ origin: 'https://a.example' }, { dv_at: 'cookie' })), undefined);
    });
});
