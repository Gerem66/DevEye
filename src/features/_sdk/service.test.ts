import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { Logger } from 'pino';
import type { FeatureId } from '@deveye/types';
import type { FeatureManifest, NativeCapability } from '@deveye/types/sdk';

import type { MonitorHub } from '@/agent/hub';
import type { Database } from '@/db';
import type { AuditEvent } from '@/Services/AuditLog';
import { setSdkHost } from './host';
import { createServiceDeps, type ModuleServiceHost } from './service';

/**
 * Les dépendances d'un service d'arrière-plan : tout y est résolu SANS
 * session.
 *
 * Ce qui mérite d'être tenu : le ticker (le patron des natives : intervalle,
 * garde de réentrance, arrêt franc, un tick qui échoue ne tue pas la boucle),
 * `devicesFor` qui passe par la même façade gardée qu'une requête, et
 * `audit` qui signe système (uid 0 sauf attribution) sous la catégorie de la
 * feature, avec l'alias historique de CloudSync.
 */

const ID: FeatureId = 'x-servicetest';

function manifest(id: FeatureId, caps: readonly NativeCapability[] = []): FeatureManifest {
    return {
        id,
        label: 'Service',
        description: 'Module de test des deps de service.',
        icon: 'test',
        category: 'daily',
        notifies: false,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: [],
        nativeCapabilities: caps
    };
}

/** L'hôte, réduit à ce que les deps lisent ; toute autre lecture serait une TypeError. */
function fakeHost() {
    const errors: { obj: unknown; msg?: string }[] = [];
    const records: AuditEvent[] = [];
    const listByWorkspaceCalls: number[] = [];
    const logger = {
        debug() {},
        info() {},
        warn() {},
        error(obj: unknown, msg?: string) {
            errors.push({ obj, msg });
        }
    };
    const host = {
        db: {
            queryable: { query: async () => ({ rows: [{ id: 1 }, { id: 4 }], rowCount: 2, insertId: 0 }) },
            devices: {
                listByWorkspace: async (ws: number) => {
                    listByWorkspaceCalls.push(ws);
                    return [
                        { id: 'dev-1', name: 'Portable', status: 'active', owner_id: 7, workspace_id: ws },
                        { id: 'dev-2', name: 'Serveur', status: 'active', owner_id: 7, workspace_id: ws }
                    ].map((r) => ({ ...r, metric_interval_seconds: null, report_json: null }));
                }
            },
            featureKv: {
                get: async () => ({
                    workspace_id: 1,
                    feature: ID,
                    k: 'secret',
                    mode: 'private',
                    value: 'blob',
                    updated: 0
                })
            }
        },
        crypt: {
            seal: (plain: Buffer) => `sealed:${plain.toString('hex')}`,
            openRaw: (sealed: string) => (sealed.startsWith('sealed:') ? Buffer.from(sealed.slice(7), 'hex') : null)
        },
        audit: {
            record: (event: AuditEvent) => {
                records.push(event);
            }
        },
        logger: logger as unknown as Logger
    } as unknown as ModuleServiceHost;
    return { host, errors, records, listByWorkspaceCalls };
}

setSdkHost({ isOnline: (deviceId: string) => deviceId === 'dev-1' } as unknown as MonitorHub, {} as Database);

const forbidden = { name: 'FeatureError', code: 'forbidden' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createServiceDeps : createTicker', () => {
    /** Le ticker sur des minuteries simulées : `t.mock.timers` se rétablit à la fin du test. */
    function ticker(t: TestContext, tick: () => Promise<void>, intervalMs = 1000) {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const { host, errors } = fakeHost();
        const service = createServiceDeps(host, manifest(ID), null).createTicker({ intervalMs, tick });
        return { service, errors };
    }

    it('appelle tick à chaque intervalle, jamais avant', async (t) => {
        let runs = 0;
        const { service } = ticker(t, async () => {
            runs += 1;
        });
        service.start();
        assert.equal(runs, 0);
        t.mock.timers.tick(999);
        assert.equal(runs, 0);
        t.mock.timers.tick(1);
        assert.equal(runs, 1);
        // Un vrai intervalle bat sur une macrotâche : les microtâches du tick
        // précédent (dont la levée de la garde) sont passées entre deux battements.
        await flush();
        t.mock.timers.tick(1000);
        assert.equal(runs, 2);
        service.stop();
    });

    it("un tick lent n'est pas doublé : les intervalles qui le chevauchent sont sautés", async (t) => {
        let runs = 0;
        let release: () => void = () => {};
        const { service } = ticker(t, () => {
            runs += 1;
            return new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        service.start();
        t.mock.timers.tick(1000);
        assert.equal(runs, 1);
        t.mock.timers.tick(1000);
        t.mock.timers.tick(1000);
        assert.equal(runs, 1, 'réentrance refusée tant que le tick court');
        release();
        await flush();
        t.mock.timers.tick(1000);
        assert.equal(runs, 2);
        service.stop();
    });

    it('stop arrête la boucle, start la relance, un double start ne la double pas', async (t) => {
        let runs = 0;
        const { service } = ticker(t, async () => {
            runs += 1;
        });
        service.start();
        service.start();
        t.mock.timers.tick(1000);
        assert.equal(runs, 1, 'un seul intervalle armé');
        await flush();
        service.stop();
        service.stop();
        t.mock.timers.tick(5000);
        assert.equal(runs, 1);
        service.start();
        t.mock.timers.tick(1000);
        assert.equal(runs, 2);
        service.stop();
    });

    it('un tick qui échoue est journalisé avec la feature, et la boucle continue', async (t) => {
        let runs = 0;
        const { service, errors } = ticker(t, async () => {
            runs += 1;
            if (runs === 1) throw new Error('boom');
        });
        service.start();
        t.mock.timers.tick(1000);
        await flush();
        assert.deepEqual(errors, [{ obj: { feature: ID, err: 'boom' }, msg: 'Module tick failed' }]);
        t.mock.timers.tick(1000);
        assert.equal(runs, 2);
        service.stop();
    });
});

describe('createServiceDeps : devicesFor', () => {
    it("sans 'devices.read' : forbidden sur list et isOnline, sans toucher à la base", async () => {
        const { host, listByWorkspaceCalls } = fakeHost();
        const devices = createServiceDeps(host, manifest(ID), null).devicesFor(1);
        await assert.rejects(devices.list(), forbidden);
        assert.throws(() => devices.isOnline('dev-1'), forbidden);
        assert.deepEqual(listByWorkspaceCalls, []);
    });

    it("avec la capacité : les appareils de l'espace demandé, présence comprise", async () => {
        const { host, listByWorkspaceCalls } = fakeHost();
        const devices = createServiceDeps(host, manifest(ID, ['devices.read']), null).devicesFor(4);
        const revealed = (id: string, name: string, online: boolean) => ({
            id,
            name,
            online,
            status: 'active',
            ownerUserId: 7,
            workspaceId: 4,
            metricIntervalSeconds: null,
            report: null
        });
        assert.deepEqual(await devices.list(), [
            revealed('dev-1', 'Portable', true),
            revealed('dev-2', 'Serveur', false)
        ]);
        assert.deepEqual(listByWorkspaceCalls, [4]);
        assert.equal(devices.isOnline('dev-1'), true);
        assert.equal(devices.isOnline('dev-2'), false);
    });

    it("n'expose que list et isOnline : authorize reste à la requête", () => {
        const { host } = fakeHost();
        const devices = createServiceDeps(host, manifest(ID, ['devices.read']), null).devicesFor(1);
        assert.deepEqual(Object.keys(devices).sort(), ['isOnline', 'list']);
    });
});

describe('createServiceDeps : audit', () => {
    it('signe système : uid 0, ip vide, info par défaut, la feature pour catégorie', () => {
        const { host, records } = fakeHost();
        createServiceDeps(host, manifest(ID), null).audit({ action: 'x.tick', description: 'tour' });
        assert.deepEqual(records, [
            {
                action: 'x.tick',
                description: 'tour',
                level: 'info',
                category: ID,
                source: 'system',
                uid: 0,
                ip: '',
                metadata: null
            }
        ]);
    });

    it("attribue la ligne à l'utilisateur donné, avec son niveau et ses métadonnées", () => {
        const { host, records } = fakeHost();
        createServiceDeps(host, manifest(ID), null).audit({
            action: 'x.warn',
            description: 'alerte',
            level: 'warning',
            userId: 7,
            metadata: { n: 1 }
        });
        assert.equal(records.length, 1);
        assert.equal(records[0].source, 'system');
        assert.equal(records[0].uid, 7);
        assert.equal(records[0].level, 'warning');
        assert.deepEqual(records[0].metadata, { n: 1 });
    });

    it("cloudsync porte l'alias historique cloudSync, les autres leur id", () => {
        const { host, records } = fakeHost();
        createServiceDeps(host, manifest('cloudsync'), null).audit({ action: 'sync.run', description: 'run' });
        createServiceDeps(host, manifest('weather'), null).audit({ action: 'weather.refresh', description: 'r' });
        assert.deepEqual(
            records.map((r) => r.category),
            ['cloudSync', 'weather']
        );
    });
});

describe('createServiceDeps : le reste, sans session', () => {
    it('deveyeFor ne tend que notify', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID, ['notify']), null);
        assert.deepEqual(Object.keys(deps.deveyeFor(1)), ['notify']);
    });

    it("storeFor est sessionless : lire une ligne 'private' lève locked", async () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null);
        await assert.rejects(deps.storeFor(1).get('secret'), { name: 'FeatureError', code: 'locked' });
    });

    it('cipherFor est mémoïsé par espace, sans lire la base à la construction', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null);
        assert.equal(deps.cipherFor(1), deps.cipherFor(1));
        assert.notEqual(deps.cipherFor(1), deps.cipherFor(2));
    });

    it('agents sans la capacité : lève avant de toucher au hub', () => {
        // À noter : ici une Error nue, là où la façade de requête (facade.ts)
        // lève un FeatureError `forbidden` pour la même faute.
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null);
        assert.throws(() => deps.agents.isOnline('dev-1'), /declare 'agents'/);
        assert.throws(() => deps.agents.publishSyncState({} as never), /declare 'agents'/);
    });

    it('agents avec la capacité : le hub', () => {
        const deps = createServiceDeps(fakeHost().host, manifest('cloudsync', ['agents']), null);
        assert.equal(deps.agents.isOnline('dev-1'), true);
        assert.equal(deps.agents.isOnline('dev-2'), false);
    });

    it('keys scelle et rouvre sous la clé serveur, null pour un blob étranger', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null);
        const sealed = deps.keys.sealBytes(new Uint8Array([1, 2, 3]));
        assert.equal(sealed, 'sealed:010203');
        assert.deepEqual(deps.keys.openBytes(sealed), Buffer.from([1, 2, 3]));
        assert.equal(deps.keys.openBytes('autre'), null);
    });

    it('listWorkspaceIds lit les ids de tous les espaces', async () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null);
        assert.deepEqual(await deps.listWorkspaceIds(), [1, 4]);
    });
});
