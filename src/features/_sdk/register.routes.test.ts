import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { createModuleServices, modulePublicRoutes, registerModules } from './register';
import type { ModuleServiceHost } from './service';

/**
 * Le montage d'une route en flux sur un vrai Fastify. Ce qui se tient ici ne
 * se voit que là : le corps arrive sans être décodé quel que soit son type, le
 * plafond de l'hôte coupe, les routes voisines gardent leur décodage JSON, et
 * l'écouteur public ne reçoit jamais la route.
 *
 * Le registre est un état de module sans remise à zéro : ce fichier a le sien.
 */

const MAX_BYTES = 1000;
const received: number[] = [];

const manifest: FeatureManifest = {
    id: 'x-sdkstream',
    label: 'Test',
    description: 'Module de test des routes en flux.',
    icon: 'test',
    category: 'daily',
    notifies: false,
    hasItems: false,
    shareTier: 'never',
    nativeCapabilities: ['routes.public'],
    resources: [],
    commands: []
};

const server: FeatureServer = {
    features: [],
    createService: () => ({
        start() {},
        stop() {},
        publicRoutes(app) {
            app.postStream('/api/x-sdkstream/upload', { exposure: 'app', maxBytes: MAX_BYTES }, async (req, reply) => {
                let total = 0;
                for await (const chunk of req.body.bytes()) total += chunk.length;
                received.push(total);
                return reply.send({ total, announced: req.body.contentLength, query: req.query });
            });
            app.post('/api/x-sdkstream/json', { exposure: 'app' }, async (req, reply) =>
                reply.send({ body: req.body })
            );
        }
    })
};

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const host = {
    db: { queryable: {}, featureKv: {} },
    crypt: {},
    audit: { record() {} },
    logger
} as unknown as ModuleServiceHost;

registerModules([{ manifest, server }]);
createModuleServices(host);

async function listener(kind: 'app' | 'public'): Promise<FastifyInstance> {
    const app = Fastify();
    await modulePublicRoutes(app, kind);
    await app.ready();
    return app;
}

let app: FastifyInstance;
before(async () => {
    app = await listener('app');
});
after(() => app.close());

describe('postStream', () => {
    it('rend les octets tels quels, quel que soit le type annoncé', async () => {
        const payload = Buffer.from('{"pas": "du json à décoder"');
        for (const type of ['application/octet-stream', 'application/json', 'video/mp4']) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/x-sdkstream/upload?token=abc',
                headers: { 'content-type': type },
                payload
            });
            assert.equal(res.statusCode, 200, type);
            assert.deepEqual(res.json(), {
                total: payload.length,
                announced: payload.length,
                query: { token: 'abc' }
            });
        }
    });

    it('coupe au-delà du plafond, sans rendre la main au module', async () => {
        const before = received.length;
        const res = await app.inject({
            method: 'POST',
            url: '/api/x-sdkstream/upload',
            headers: { 'content-type': 'application/octet-stream' },
            payload: Buffer.alloc(MAX_BYTES + 1)
        });
        assert.ok(res.statusCode >= 400);
        assert.equal(received.length, before);
    });

    it('laisse aux routes voisines leur décodage', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/x-sdkstream/json',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify({ a: 1 })
        });
        assert.deepEqual(res.json(), { body: { a: 1 } });
    });

    it('ne se monte jamais sur l’écouteur public', async () => {
        const open = await listener('public');
        try {
            const res = await open.inject({ method: 'POST', url: '/api/x-sdkstream/upload', payload: Buffer.alloc(4) });
            assert.equal(res.statusCode, 404);
        } finally {
            await open.close();
        }
    });
});
