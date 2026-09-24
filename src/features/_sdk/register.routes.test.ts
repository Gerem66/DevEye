import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { FeatureMaintenanceLevel } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import { maintenance } from '@/Services/maintenance';
import { createModuleServices, modulePublicRoutes, parseFormFields, registerModules } from './register';
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
            app.get('/api/x-sdkstream/page', {}, async (_req, reply) => reply.send({ page: true }));
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

/**
 * Le décodage d'un `<form method="post">`, partagé par les deux écouteurs. Ce
 * qui se tient ici est une borne : sans elle, un corps d'un mégaoctet descend
 * entrée par entrée dans la validation du module avant qu'aucun plafond de
 * cardinalité ne morde.
 */
describe('parseFormFields', () => {
    it('groupe un nom répété, sans quoi des cases à cocher perdraient leurs valeurs', () => {
        assert.deepEqual(
            { ...parseFormFields('_key=pk_1&canaux=mail&canaux=sms&message=bonjour') },
            {
                _key: 'pk_1',
                canaux: ['mail', 'sms'],
                message: 'bonjour'
            }
        );
    });

    it('refuse le corps entier au-delà du plafond de champs, plutôt que d’en perdre en route', () => {
        const pairs = (n: number) => Array.from({ length: n }, (_, i) => `a${i}=x`).join('&');
        assert.notEqual(parseFormFields(pairs(64)), undefined);
        assert.equal(parseFormFields(pairs(65)), undefined);
        // Un nom répété ne consomme qu'une place : c'est un champ, pas deux.
        assert.notEqual(parseFormFields(`${pairs(64)}&a0=y&a0=z`), undefined);
    });

    it('rend un objet sans prototype : `__proto__` est une réponse, pas un accesseur', () => {
        const fields = parseFormFields('__proto__=x&message=bonjour');
        assert.equal(Object.getPrototypeOf(fields), null);
        assert.deepEqual(Object.keys(fields ?? {}), ['__proto__', 'message']);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });
});

/**
 * Le filtre de maintenance, posé au montage : une route ouverte au public se
 * ferme avec le site ou sa feature ; une route réservée à l'app prolonge une
 * commande déjà gardée et passe, sauf à l'arrêt complet.
 */
describe('routes publiques en maintenance', () => {
    const state = { site: false, level: null as FeatureMaintenanceLevel | null };
    const db = {
        users: { listAdminIds: async () => [] },
        maintenance: {
            site: async () => ({
                active: state.site,
                message: 'Retour à midi',
                envNoticeDismissed: false,
                updated: 0,
                updatedBy: null
            }),
            features: async () =>
                state.level ? [{ feature: 'x-sdkstream', level: state.level, updated: 0, updatedBy: null }] : [],
            setSite: async (active: boolean) => {
                state.site = active;
            },
            setFeature: async (_feature: string, level: FeatureMaintenanceLevel | null) => {
                state.level = level;
            }
        }
    } as unknown as Database;
    const live = { broadcast() {}, closeWhere() {} } as unknown as LiveHub;
    const services = {
        installed: () => ['x-sdkstream'],
        hasService: () => false,
        stop: async () => undefined,
        start: async () => undefined
    };

    before(() => maintenance.init({ db, live, logger: logger as never, services }));
    after(() => maintenance.close());

    it('répond 503 lisible à un visiteur et en enveloppe à un programme, le site fermé', async () => {
        await maintenance.setSite(true, null, 1);
        try {
            const api = await app.inject({ method: 'GET', url: '/api/x-sdkstream/page' });
            assert.equal(api.statusCode, 503);
            assert.equal(api.json().error.code, 'maintenance');
            const page = await app.inject({
                method: 'GET',
                url: '/api/x-sdkstream/page',
                headers: { accept: 'text/html' }
            });
            assert.equal(page.statusCode, 503);
            assert.match(page.headers['content-type'] ?? '', /text\/html/);
            assert.match(page.body, /Retour à midi/);
            const own = await app.inject({ method: 'POST', url: '/api/x-sdkstream/json', payload: { a: 1 } });
            assert.equal(own.statusCode, 200);
        } finally {
            await maintenance.setSite(false, null, 1);
        }
    });

    it('laisse ouvertes les routes publiques de la préversion', async () => {
        await maintenance.setFeature('x-sdkstream', 'preview', 1);
        try {
            const open = await app.inject({ method: 'GET', url: '/api/x-sdkstream/page' });
            assert.equal(open.statusCode, 200);
        } finally {
            await maintenance.setFeature('x-sdkstream', null, 1);
        }
    });

    it("ferme aussi les routes de l'app à l'arrêt complet de la feature", async () => {
        await maintenance.setFeature('x-sdkstream', 'requests', 1);
        const own = await app.inject({ method: 'POST', url: '/api/x-sdkstream/json', payload: { a: 1 } });
        assert.equal(own.statusCode, 200);
        const open = await app.inject({ method: 'GET', url: '/api/x-sdkstream/page' });
        assert.equal(open.statusCode, 503);
        await maintenance.setFeature('x-sdkstream', 'full', 1);
        const stopped = await app.inject({ method: 'POST', url: '/api/x-sdkstream/json', payload: { a: 1 } });
        assert.equal(stopped.statusCode, 503);
        await maintenance.setFeature('x-sdkstream', null, 1);
        const back = await app.inject({ method: 'GET', url: '/api/x-sdkstream/page' });
        assert.equal(back.statusCode, 200);
    });
});
