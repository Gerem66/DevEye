import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import {
    createModuleServices,
    listenerPortForHost,
    moduleListeners,
    modulePublicRoutes,
    registerModules
} from './register';
import type { ModuleServiceHost } from './service';

/**
 * Un module qui tient son propre écouteur : ses routes n'existent que là, et
 * cet écouteur ne porte rien d'autre. Ni la surface publique ni l'app ne le
 * servent, même sous son propre nom.
 *
 * Le registre est un état de module sans remise à zéro : ce fichier a le sien.
 */

function manifest(id: `x-${string}`): FeatureManifest {
    return {
        id,
        label: 'Test',
        description: 'Module de test des écouteurs propres.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        nativeCapabilities: ['routes.public'],
        resources: [],
        commands: []
    };
}

const alone: FeatureServer = {
    features: [],
    createService: () => ({
        start() {},
        stop() {},
        ownHosts: ['court.exemple.fr'],
        ownListener: { port: 3902 },
        publicRoutes(app) {
            app.get('/l/:code', {}, async (_req, reply) => reply.send({ route: 'seul' }));
        },
        hostRequest: async (req, reply) => reply.send({ path: req.path })
    })
};

const shared: FeatureServer = {
    features: [],
    createService: () => ({
        start() {},
        stop() {},
        publicRoutes(app) {
            app.get('/p/:id', {}, async (_req, reply) => reply.send({ route: 'partagé' }));
        }
    })
};

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
registerModules([
    { manifest: manifest('x-sdkalone'), server: alone },
    { manifest: manifest('x-sdkshared'), server: shared }
]);
createModuleServices({
    db: { queryable: {}, featureKv: {} },
    crypt: {},
    audit: { record() {} },
    logger
} as unknown as ModuleServiceHost);

let surface: FastifyInstance;
let own: FastifyInstance;
before(async () => {
    surface = Fastify();
    await modulePublicRoutes(surface, 'public');
    await surface.ready();
    own = Fastify();
    await modulePublicRoutes(own, { only: 'x-sdkalone' });
    await own.ready();
});
after(async () => {
    await surface.close();
    await own.close();
});

const get = (app: FastifyInstance, host: string, url: string) => app.inject({ method: 'GET', url, headers: { host } });

describe('ownListener', () => {
    it('ne laisse rien du module sur la surface publique, même sous son nom', async () => {
        assert.equal((await get(surface, 'public.deveye.test', '/l/abc')).statusCode, 404);
        assert.equal((await get(surface, 'court.exemple.fr', '/abc')).statusCode, 404);
        assert.equal((await get(surface, 'court.exemple.fr', '/l/abc')).statusCode, 404);
        assert.deepEqual((await get(surface, 'public.deveye.test', '/p/1')).json(), { route: 'partagé' });
    });

    it('sert le module sur son écouteur, et lui seul', async () => {
        assert.deepEqual((await get(own, 'court.exemple.fr', '/abc')).json(), { path: '/abc' });
        assert.deepEqual((await get(own, 'court.exemple.fr', '/l/abc')).json(), { route: 'seul' });
        // La route de l'autre module n'existe pas ici : le chemin revient au module seul.
        assert.deepEqual((await get(own, 'court.exemple.fr', '/p/1')).json(), { path: '/p/1' });
        assert.equal((await get(own, 'localhost', '/abc')).statusCode, 404);
    });

    it('se déclare au démarrage et aux essais de bout en bout', () => {
        assert.deepEqual(moduleListeners(), [{ featureId: 'x-sdkalone', port: 3902 }]);
        assert.equal(listenerPortForHost('Court.Exemple.fr:443'), 3902);
        assert.equal(listenerPortForHost('autre.exemple.fr'), null);
    });
});
