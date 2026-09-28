import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import type { LiveHub } from '@/live/hub';
import { maintenance } from '@/Services/maintenance';
import { createModuleServices, modulePublicRoutes, registerModules } from './register';
import type { ModuleServiceHost } from './service';

/**
 * La racine d'un domaine client, sur de vrais écouteurs : servie par le module
 * qui a vérifié le nom, jamais pour un nom seulement pointé ni pour les hôtes
 * de DevEye, et rendue au repli de l'écouteur sinon.
 *
 * Le registre est un état de module sans remise à zéro : ce fichier a le sien.
 */

const manifest: FeatureManifest = {
    id: 'x-sdkroot',
    label: 'Test',
    description: 'Module de test de la racine des domaines.',
    icon: 'test',
    category: 'daily',
    notifies: false,
    hasItems: false,
    shareTier: 'never',
    nativeCapabilities: ['routes.public'],
    domains: { hint: 'Vos domaines.', service: 'Relier au service.', web: true },
    settings: { feature: ['domains'] },
    resources: [],
    commands: []
};

const server: FeatureServer = {
    features: [],
    domains: {
        records: async () => [],
        probe: async () => ({ ok: true })
    },
    createService: () => ({
        start() {},
        stop() {},
        domainRoot: async (_req, reply, domain) => reply.send({ root: domain.host, workspace: domain.workspaceId })
    })
};

function row(host: string, verified: boolean): FeatureDomainRow {
    return {
        id: host.length,
        workspace_id: 7,
        feature: 'x-sdkroot',
        host,
        token: 't',
        verified_at: verified ? 1 : null
    } as FeatureDomainRow;
}

const ROWS = [row('statut.exemple.fr', true), row('pointe.exemple.fr', false)];

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const host = {
    db: {
        queryable: {},
        featureKv: {},
        featureDomains: {
            findByHost: async (feature: string, name: string) =>
                ROWS.find((r) => r.feature === feature && r.host === name) ?? null
        }
    },
    crypt: {},
    audit: { record() {} },
    logger
} as unknown as ModuleServiceHost;

registerModules([{ manifest, server }]);
createModuleServices(host);

async function listener(kind: 'app' | 'public'): Promise<FastifyInstance> {
    const app = Fastify();
    // Le repli de l'écouteur de l'app : le client.
    if (kind === 'app') app.setNotFoundHandler((_req, reply) => reply.send('client'));
    await modulePublicRoutes(app, kind);
    await app.ready();
    return app;
}

let open: FastifyInstance;
let own: FastifyInstance;
before(async () => {
    open = await listener('public');
    own = await listener('app');
});
after(async () => {
    await open.close();
    await own.close();
});

const root = (app: FastifyInstance, name: string, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({ method, url: '/', headers: { host: name } });

describe('domainRoot', () => {
    it('sert la racine d’un domaine vérifié, sur les deux écouteurs, port et casse ignorés', async () => {
        for (const app of [open, own]) {
            const res = await root(app, 'Statut.Exemple.fr:443');
            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.json(), { root: 'statut.exemple.fr', workspace: 7 });
        }
    });

    it('ne sert pas un nom seulement pointé', async () => {
        assert.equal((await root(open, 'pointe.exemple.fr')).statusCode, 404);
        assert.equal((await root(own, 'pointe.exemple.fr')).body, 'client');
    });

    it('rend la racine de DevEye à son repli, le client sur l’app et 404 ailleurs', async () => {
        assert.equal((await root(open, 'localhost:3000')).statusCode, 404);
        const app = await root(own, 'localhost:3000');
        assert.equal(app.statusCode, 200);
        assert.equal(app.body, 'client');
        assert.equal((await root(own, 'localhost:3000', 'HEAD')).statusCode, 200);
    });

    it('ne sert rien pour un nom inconnu ou mal formé', async () => {
        assert.equal((await root(open, 'inconnu.exemple.fr')).statusCode, 404);
        assert.equal((await root(open, 'pas un nom')).statusCode, 404);
    });
});

describe('domainRoot en maintenance', () => {
    const state = { site: false };
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
            features: async () => [],
            setSite: async (active: boolean) => {
                state.site = active;
            },
            setFeature: async () => undefined
        }
    } as unknown as Database;
    const live = { broadcast() {}, closeWhere() {} } as unknown as LiveHub;
    const services = {
        installed: () => ['x-sdkroot'],
        hasService: () => false,
        stop: async () => undefined,
        start: async () => undefined
    };

    before(() => maintenance.init({ db, live, logger: logger as never, services, hasPlanProvider: () => false }));
    after(() => maintenance.close());

    it('ferme la racine d’un domaine client avec le site', async () => {
        await maintenance.setSite(true, null, 1);
        try {
            const res = await open.inject({
                method: 'GET',
                url: '/',
                headers: { host: 'statut.exemple.fr', accept: 'text/html' }
            });
            assert.equal(res.statusCode, 503);
            assert.match(res.body, /Retour à midi/);
        } finally {
            await maintenance.setSite(false, null, 1);
        }
    });
});
