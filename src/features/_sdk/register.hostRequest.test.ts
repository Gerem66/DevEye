import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureServer, FeatureService } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import type { LiveHub } from '@/live/hub';
import { maintenance } from '@/Services/maintenance';
import { createModuleServices, hostHooksProblem, modulePublicRoutes, registerModules, reservedHosts } from './register';
import type { ModuleServiceHost } from './service';

/**
 * Les noms servis en entier, sur de vrais écouteurs : l'hôte propre d'un module
 * et ses domaines vérifiés lui rendent tout chemin sans route, racine comprise ;
 * un nom seulement pointé et les hôtes de DevEye retombent sur le repli de
 * l'écouteur, et une route déclarée bat toujours la route générique.
 *
 * Le registre est un état de module sans remise à zéro : ce fichier a le sien.
 */

const manifest: FeatureManifest = {
    id: 'x-sdkhost',
    label: 'Test',
    description: 'Module de test des noms servis en entier.',
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
        ownHosts: ['Court.Exemple.fr'],
        publicRoutes(app) {
            app.get('/l/:code', {}, async (_req, reply) => reply.send({ route: 'declared' }));
        },
        hostRequest: async (req, reply, domain) =>
            reply.send({ path: req.path, method: req.method, domain: domain?.host ?? null })
    })
};

function row(host: string, verified: boolean): FeatureDomainRow {
    return {
        id: host.length,
        workspace_id: 7,
        feature: 'x-sdkhost',
        host,
        token: 't',
        verified_at: verified ? 1 : null
    } as FeatureDomainRow;
}

const ROWS = [row('go.exemple.fr', true), row('pointe.exemple.fr', false)];

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

const get = (app: FastifyInstance, name: string, url: string, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({ method, url, headers: { host: name } });

describe('hostRequest', () => {
    it('sert tout chemin de l’hôte propre, racine comprise, sur les deux écouteurs', async () => {
        for (const app of [open, own]) {
            const res = await get(app, 'court.exemple.fr:443', '/k3x9p2?utm=1');
            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.json(), { path: '/k3x9p2', method: 'GET', domain: null });
            assert.deepEqual((await get(app, 'court.exemple.fr', '/')).json(), {
                path: '/',
                method: 'GET',
                domain: null
            });
        }
    });

    it('sert un domaine vérifié hors racine et à la racine, avec ce domaine', async () => {
        assert.deepEqual((await get(open, 'Go.Exemple.fr', '/promo')).json(), {
            path: '/promo',
            method: 'GET',
            domain: 'go.exemple.fr'
        });
        assert.deepEqual((await get(open, 'go.exemple.fr', '/')).json(), {
            path: '/',
            method: 'GET',
            domain: 'go.exemple.fr'
        });
    });

    it('laisse une route déclarée répondre avant la route générique', async () => {
        assert.deepEqual((await get(open, 'court.exemple.fr', '/l/abc')).json(), { route: 'declared' });
    });

    it('ne sert pas un nom seulement pointé ni un nom inconnu', async () => {
        assert.equal((await get(open, 'pointe.exemple.fr', '/promo')).statusCode, 404);
        assert.equal((await get(own, 'pointe.exemple.fr', '/promo')).body, 'client');
        assert.equal((await get(open, 'inconnu.exemple.fr', '/promo')).statusCode, 404);
    });

    it('rend les chemins de DevEye à leur repli, le client sur l’app et 404 ailleurs', async () => {
        assert.equal((await get(open, 'localhost:3000', '/inscription')).statusCode, 404);
        const page = await get(own, 'localhost:3000', '/inscription');
        assert.equal(page.statusCode, 200);
        assert.equal(page.body, 'client');
    });

    it('les noms propres sont réservés', () => {
        assert.ok(reservedHosts().includes('court.exemple.fr'));
    });
});

describe('hostHooksProblem', () => {
    const service = (extra: Partial<FeatureService>): FeatureService => ({ start() {}, stop() {}, ...extra });
    const hook = async () => undefined;
    const origins = ['app.deveye.test', 'api.deveye.test'];
    const PORTS = [3000, 3001];

    it('accepte un module bien déclaré', () => {
        assert.equal(hostHooksProblem([{ manifest, service: service({ hostRequest: hook }) }], origins, PORTS), null);
    });

    it('refuse hostRequest avec domainRoot, sans porte publique, ou sur des domaines qui ne sont pas des sites', () => {
        const both = service({ hostRequest: hook, domainRoot: hook });
        assert.match(hostHooksProblem([{ manifest, service: both }], origins, PORTS) ?? '', /s'excluent/);
        const closed = { ...manifest, nativeCapabilities: [] };
        assert.match(
            hostHooksProblem([{ manifest: closed, service: service({ hostRequest: hook }) }], origins, PORTS) ?? '',
            /routes\.public/
        );
        const notWeb = { ...manifest, domains: { hint: 'h', service: 's' } };
        assert.match(
            hostHooksProblem([{ manifest: notWeb, service: service({ hostRequest: hook }) }], origins, PORTS) ?? '',
            /domains\.web/
        );
    });

    it('refuse un hôte propre sans hostRequest, mal formé, de DevEye, ou revendiqué deux fois', () => {
        const check = (extra: Partial<FeatureService>) =>
            hostHooksProblem([{ manifest, service: service(extra) }], origins, PORTS) ?? '';
        assert.match(check({ ownHosts: ['a.exemple.fr'] }), /sans hostRequest/);
        assert.match(check({ ownHosts: ['localhost'], hostRequest: hook }), /invalide/);
        assert.match(check({ ownHosts: ['API.deveye.test'], hostRequest: hook }), /nom de DevEye/);
        const twice = service({ ownHosts: ['a.exemple.fr'], hostRequest: hook });
        assert.match(
            hostHooksProblem(
                [
                    { manifest, service: twice },
                    { manifest: { ...manifest, id: 'x-other' }, service: twice }
                ],
                origins,
                PORTS
            ) ?? '',
            /revendiqué/
        );
    });

    it('refuse un écouteur propre sans hôte propre, sur un port invalide, de DevEye, ou pris deux fois', () => {
        const check = (extra: Partial<FeatureService>) =>
            hostHooksProblem([{ manifest, service: service(extra) }], origins, PORTS) ?? '';
        const withHost = { ownHosts: ['a.exemple.fr'], hostRequest: hook };
        assert.equal(check({ ...withHost, ownListener: { port: 3002 } }), '');
        assert.match(check({ hostRequest: hook, ownListener: { port: 3002 } }), /écouteur propre exige/);
        assert.match(check({ ...withHost, ownListener: { port: 0 } }), /port d'écouteur invalide/);
        assert.match(check({ ...withHost, ownListener: { port: 3001 } }), /déjà un écouteur de DevEye/);
        const twice = (host: string) => service({ ownHosts: [host], hostRequest: hook, ownListener: { port: 3002 } });
        assert.match(
            hostHooksProblem(
                [
                    { manifest, service: twice('a.exemple.fr') },
                    { manifest: { ...manifest, id: 'x-other' }, service: twice('b.exemple.fr') }
                ],
                origins,
                PORTS
            ) ?? '',
            /Port 3002 revendiqué/
        );
    });
});

describe('hostRequest en maintenance', () => {
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
        installed: () => ['x-sdkhost'],
        hasService: () => false,
        stop: async () => undefined,
        start: async () => undefined
    };

    before(() => maintenance.init({ db, live, logger: logger as never, services, hasPlanProvider: () => false }));
    after(() => maintenance.close());

    it('ferme l’hôte propre avec le site', async () => {
        await maintenance.setSite(true, null, 1);
        try {
            const res = await open.inject({
                method: 'GET',
                url: '/k3x9p2',
                headers: { host: 'court.exemple.fr', accept: 'text/html' }
            });
            assert.equal(res.statusCode, 503);
            assert.match(res.body, /Retour à midi/);
        } finally {
            await maintenance.setSite(false, null, 1);
        }
    });
});
