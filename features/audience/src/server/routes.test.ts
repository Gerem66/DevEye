import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkPublicApp, SdkPublicHandler, SdkPublicReply, SdkPublicRouteOptions } from '@deveye/types/sdk/server';

import { audienceRoutes } from './routes';
import { TRACKER_SCRIPT, TRACKER_SCRIPT_ETAG } from './script';
import type { AudienceIngest, IngestRequest } from './service';

/**
 * Les routes publiques du module, sur une surface `SdkPublicApp` factice. On
 * tient ce que l'hôte ne vérifie pas pour nous : le script servi avec son type,
 * son cache et son ETag (un ETag connu rend `304`), un lot valide qui atteint
 * l'ingestion avec l'origine, le user-agent et l'adresse, un corps invalide qui
 * rend le même `204` sans l'atteindre, le plafond de débit des deux POST, et
 * les trois réponses chargeables depuis une autre origine (CORP).
 */

const KEY = 'pk_000000000000000000000001';

interface Route {
    method: 'get' | 'post';
    path: string;
    opts: SdkPublicRouteOptions;
    handler: SdkPublicHandler;
}

function fakeApp(): { app: SdkPublicApp; routes: Route[] } {
    const routes: Route[] = [];
    return {
        routes,
        app: {
            get: (path, opts, handler) => routes.push({ method: 'get', path, opts, handler }),
            post: (path, opts, handler) => routes.push({ method: 'post', path, opts, handler })
        }
    };
}

function fakeReply() {
    const state = { status: 200, headers: {} as Record<string, string>, payload: undefined as unknown };
    const reply: SdkPublicReply = {
        header(name, value) {
            state.headers[name] = value;
            return reply;
        },
        code(status) {
            state.status = status;
            return reply;
        },
        send(payload) {
            state.payload = payload;
            return reply;
        }
    };
    return { reply, state };
}

function mount() {
    const accepted: IngestRequest[] = [];
    const ingest = {
        accept: async (req: IngestRequest) => {
            accepted.push(req);
        }
    } as unknown as AudienceIngest;
    const { app, routes } = fakeApp();
    audienceRoutes(app, ingest);
    const routeOf = (method: Route['method'], path: string) => {
        const route = routes.find((r) => r.method === method && r.path === path);
        assert.ok(route, `route ${method} ${path} manquante`);
        return route;
    };
    return { routes, accepted, routeOf };
}

const headers = {
    origin: 'https://exemple.fr',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0'
};

describe('la déclaration', () => {
    it('déclare le script et les deux points d’entrée, les POST avec leur plafond', () => {
        const { routes } = mount();
        assert.deepEqual(
            routes.map((r) => [r.method, r.path, r.opts.rateLimit ?? null]),
            [
                ['get', '/t.js', null],
                ['post', '/api/t/b', { max: 600, timeWindow: '1 minute' }],
                ['post', '/api/t/e', { max: 600, timeWindow: '1 minute' }]
            ]
        );
    });
});

describe('GET /t.js', () => {
    it('sert le script avec son type, son cache, son ETag, chargeable d’ailleurs', async () => {
        const { routeOf } = mount();
        const { reply, state } = fakeReply();
        await routeOf('get', '/t.js').handler({ headers: {}, body: undefined, ip: '203.0.113.7' }, reply);
        assert.equal(state.status, 200);
        assert.equal(state.payload, TRACKER_SCRIPT);
        assert.equal(state.headers['Content-Type'], 'application/javascript; charset=utf-8');
        assert.equal(state.headers['Cache-Control'], 'public, max-age=3600');
        assert.equal(state.headers['ETag'], TRACKER_SCRIPT_ETAG);
        assert.equal(state.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    });

    it('rend 304 sans corps sur un ETag connu', async () => {
        const { routeOf } = mount();
        const { reply, state } = fakeReply();
        await routeOf('get', '/t.js').handler(
            { headers: { 'if-none-match': TRACKER_SCRIPT_ETAG }, body: undefined, ip: '203.0.113.7' },
            reply
        );
        assert.equal(state.status, 304);
        assert.equal(state.payload, undefined);
        assert.equal(state.headers['ETag'], TRACKER_SCRIPT_ETAG);
    });
});

describe('POST /api/t/b', () => {
    it('transmet un lot valide à l’ingestion, avec l’origine, le user-agent et l’adresse', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        const body = {
            key: KEY,
            visitorId: 'v-1',
            events: [
                { type: 'view', path: '/' },
                { type: 'event', path: '/', name: 'clic' }
            ]
        };
        await routeOf('post', '/api/t/b').handler({ headers, body, ip: '203.0.113.7' }, reply);
        assert.equal(state.status, 204);
        assert.equal(state.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
        assert.deepEqual(accepted, [
            {
                key: KEY,
                visitorId: 'v-1',
                origin: 'https://exemple.fr',
                ip: '203.0.113.7',
                userAgent: headers['user-agent'],
                events: body.events
            }
        ]);
    });

    it('rend le même 204 sur un corps invalide, sans atteindre l’ingestion', async () => {
        const { routeOf, accepted } = mount();
        for (const body of [
            undefined,
            'texte',
            { key: 'court', events: [{ type: 'view', path: '/' }] },
            { key: KEY, events: [] }
        ]) {
            const { reply, state } = fakeReply();
            await routeOf('post', '/api/t/b').handler({ headers, body, ip: '203.0.113.7' }, reply);
            assert.equal(state.status, 204);
        }
        assert.deepEqual(accepted, []);
    });
});

describe('POST /api/t/e', () => {
    it('transmet un événement isolé, `Origin` absent compris (un client natif n’en envoie pas)', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/e').handler(
            {
                headers: { 'user-agent': 'curl/8.0' },
                body: { key: KEY, type: 'event', path: '/x', name: 'ping' },
                ip: '203.0.113.7'
            },
            reply
        );
        assert.equal(state.status, 204);
        assert.deepEqual(
            accepted.map((a) => [a.key, a.origin, a.userAgent, a.visitorId, a.events.length, a.events[0].name]),
            [[KEY, null, 'curl/8.0', null, 1, 'ping']]
        );
    });

    it('sans clé, rien n’atteint l’ingestion', async () => {
        const { routeOf, accepted } = mount();
        const { reply, state } = fakeReply();
        await routeOf('post', '/api/t/e').handler(
            { headers, body: { type: 'view', path: '/' }, ip: '203.0.113.7' },
            reply
        );
        assert.equal(state.status, 204);
        assert.deepEqual(accepted, []);
    });
});
