import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Headers, Response } from 'undici';

import {
    assertAllowedOutboundHost,
    publicLookup,
    safeFetch,
    setAllowPrivateForTest,
    setSafeFetchTransportForTest,
    UnsafeTargetError
} from './netFetch';

describe('safeFetch', () => {
    it('refuse une cible interne avant toute connexion', async () => {
        for (const url of [
            'http://127.0.0.1:3306/',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5/',
            'http://[::1]/',
            'http://localhost/',
            'file:///etc/passwd',
            'javascript:alert(1)'
        ]) {
            await assert.rejects(safeFetch(url), UnsafeTargetError, url);
        }
    });
});

describe('safeFetch : les redirections', () => {
    /** Chaque saut reçu, et les en-têtes secrets qu'il portait. */
    async function follow(
        from: string,
        to: string
    ): Promise<{ url: string; auth: string | null; key: string | null }[]> {
        const hops: { url: string; auth: string | null; key: string | null }[] = [];
        setSafeFetchTransportForTest(async (url, init) => {
            const headers = new Headers(init.headers);
            hops.push({ url, auth: headers.get('authorization'), key: headers.get('x-api-key') });
            return hops.length === 1
                ? new Response(null, { status: 302, headers: { location: to } })
                : new Response('ok', { status: 200 });
        });
        try {
            await safeFetch(from, {
                headers: { authorization: 'Bearer secret', 'x-api-key': 'clé', accept: 'text/plain' }
            });
        } finally {
            setSafeFetchTransportForTest(null);
        }
        return hops;
    }

    it('ne porte pas un secret chez un autre hôte', async () => {
        const hops = await follow('https://api.exemple.fr/logs', 'https://stockage.exemple.net/fichier');
        assert.deepEqual(hops[1], { url: 'https://stockage.exemple.net/fichier', auth: null, key: null });
    });

    it('le garde sur le même hôte, passage à https compris', async () => {
        const hops = await follow('http://api.exemple.fr/logs', 'https://api.exemple.fr/logs');
        assert.deepEqual(hops[1], { url: 'https://api.exemple.fr/logs', auth: 'Bearer secret', key: 'clé' });
    });
});

describe('publicLookup', () => {
    it('refuse un nom qui résout vers une adresse non publique', (_, done) => {
        // `localhost` passe par le résolveur système : c'est le cas d'un nom
        // public dont l'enregistrement pointe vers l'intérieur.
        publicLookup('localhost', {}, (err) => {
            assert.equal(err?.code, 'ENOTPUBLIC');
            done();
        });
    });
});

describe('assertAllowedOutboundHost', () => {
    it('refuse une IP littérale interne, qu’aucune résolution ne verrait passer', async () => {
        for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '[::1]']) {
            await assert.rejects(assertAllowedOutboundHost(host), UnsafeTargetError, host);
        }
        await assert.rejects(assertAllowedOutboundHost('localhost'), UnsafeTargetError);
    });

    it('laisse passer une adresse publique', async () => {
        await assertAllowedOutboundHost('93.184.216.34');
    });

    it('ouvre le réseau privé quand l’instance l’autorise, sauf le lien-local', async () => {
        setAllowPrivateForTest(true);
        try {
            await assertAllowedOutboundHost('10.0.0.5');
            await assert.rejects(assertAllowedOutboundHost('169.254.169.254'), UnsafeTargetError);
        } finally {
            setAllowPrivateForTest(false);
        }
    });
});
