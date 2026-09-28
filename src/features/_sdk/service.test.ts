import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { Logger } from 'pino';
import type { FeatureId } from '@deveye/types';
import type { FeatureManifest, NativeCapability } from '@deveye/types/sdk';

import type { MonitorHub } from '@/agent/hub';
import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import type { AuditEvent } from '@/Services/AuditLog';
import type { MailMessage } from '@/Services/mailer';
import { setSdkHost } from './host';
import { createServiceDeps, type ModuleServiceHost } from './service';
import type { SdkProviders } from '@deveye/types/sdk/server';

/** Aucun contrat offert : ce que ces tests n'exercent pas. */
const NO_PROVIDERS: SdkProviders = { get: () => undefined };

/**
 * Les dépendances d'un service d'arrière-plan, résolues sans session : le
 * ticker (intervalle, réentrance, arrêt, un tick qui échoue ne tue pas la
 * boucle), `devicesFor` par la même façade gardée qu'une requête, et `audit`
 * qui signe système sous la catégorie de la feature.
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
    const searchCalls: { query: string; limit: number }[] = [];
    const sent: MailMessage[] = [];
    const mailer = {
        configured: true,
        send: async (message: MailMessage) => void sent.push(message),
        verify: async () => {}
    };
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
            users: {
                findById: async (id: number) =>
                    id === 7
                        ? {
                              id: 7,
                              email: 'alice@exemple.fr',
                              username: 'alice',
                              role: 'user',
                              created: 12,
                              e2e_run: null
                          }
                        : null,
                search: async (query: string, limit: number) => {
                    searchCalls.push({ query, limit });
                    return [
                        {
                            id: 7,
                            email: 'alice@exemple.fr',
                            username: 'alice',
                            role: 'admin',
                            created: 12,
                            e2e_run: null
                        }
                    ];
                },
                all: async () => [
                    {
                        id: 7,
                        email: 'alice@exemple.fr',
                        username: 'alice',
                        role: 'user',
                        status: 'suspended',
                        created: 12,
                        e2e_run: null
                    }
                ],
                listAdminIds: async () => [7, 11],
                findByIds: async (ids: number[]) =>
                    [
                        { id: 7, username: 'alice', color: 'blue' },
                        { id: 9, username: 'bob', color: '' }
                    ].filter((u) => ids.includes(u.id))
            },
            // L'espace 4 appartient à alice, qui n'y a pas de ligne de membre.
            workspaces: { findById: async (id: number) => (id === 4 ? { id: 4, owner_user_id: 7 } : null) },
            workspaceMembers: {
                listByWorkspaceIds: async (ids: number[]) => (ids.includes(4) ? [{ workspace_id: 4, user_id: 9 }] : [])
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
            sealFor: (label: string, plain: Buffer, context: string) =>
                `sealed:${label}:${context}:${plain.toString('hex')}`,
            openFor: (label: string, sealed: string, context: string) => {
                const prefix = `sealed:${label}:${context}:`;
                return sealed.startsWith(prefix) ? Buffer.from(sealed.slice(prefix.length), 'hex') : null;
            }
        },
        audit: {
            record: (event: AuditEvent) => {
                records.push(event);
            }
        },
        logger: logger as unknown as Logger,
        mailer
    } as unknown as ModuleServiceHost;
    return { host, errors, records, listByWorkspaceCalls, searchCalls, sent, mailer };
}

setSdkHost(
    { isOnline: (deviceId: string) => deviceId === 'dev-1' } as unknown as MonitorHub,
    {} as Database,
    { publishFeature: () => undefined } as unknown as LiveHub
);

const forbidden = { name: 'FeatureError', code: 'forbidden' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createServiceDeps : createTicker', () => {
    /** Le ticker sur des minuteries simulées : `t.mock.timers` se rétablit à la fin du test. */
    function ticker(t: TestContext, tick: () => Promise<void>, intervalMs = 1000) {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const { host, errors } = fakeHost();
        const service = createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).createTicker({
            intervalMs,
            tick
        });
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

    it('stop attend le tick en vol avant de rendre la main', async (t) => {
        let release: () => void = () => {};
        const { service } = ticker(
            t,
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );
        service.start();
        t.mock.timers.tick(1000);
        let stopped = false;
        const stopping = Promise.resolve(service.stop()).then(() => {
            stopped = true;
        });
        await flush();
        assert.equal(stopped, false, 'le tick court encore');
        release();
        await stopping;
        assert.equal(stopped, true);
        await service.stop();
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
        assert.equal(errors.length, 1);
        const [logged] = errors as { obj: { feature: string; err: unknown }; msg: string }[];
        assert.equal(logged.msg, 'Module tick failed');
        assert.equal(logged.obj.feature, ID);
        // L'erreur entière, pas son message : pino en sérialise la pile.
        assert.ok(logged.obj.err instanceof Error && logged.obj.err.message === 'boom');
        t.mock.timers.tick(1000);
        assert.equal(runs, 2);
        service.stop();
    });
});

describe('createServiceDeps : devicesFor', () => {
    it("sans 'devices.read' : forbidden sur list et isOnline, sans toucher à la base", async () => {
        const { host, listByWorkspaceCalls } = fakeHost();
        const devices = createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).devicesFor(1);
        await assert.rejects(devices.list(), forbidden);
        assert.throws(() => devices.isOnline('dev-1'), forbidden);
        assert.deepEqual(listByWorkspaceCalls, []);
    });

    it("avec la capacité : les appareils de l'espace demandé, présence comprise", async () => {
        const { host, listByWorkspaceCalls } = fakeHost();
        const devices = createServiceDeps(
            host,
            manifest(ID, ['devices.read']),
            null,
            NO_PROVIDERS,
            undefined
        ).devicesFor(4);
        const revealed = (id: string, name: string, online: boolean) => ({
            id,
            name,
            online,
            status: 'active',
            ownerUserId: 7,
            workspaceId: 4,
            metricIntervalSeconds: null,
            effectiveMetricIntervalSeconds: 60,
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
        const devices = createServiceDeps(
            host,
            manifest(ID, ['devices.read']),
            null,
            NO_PROVIDERS,
            undefined
        ).devicesFor(1);
        assert.deepEqual(Object.keys(devices).sort(), ['isOnline', 'list']);
    });
});

describe('createServiceDeps : membersFor', () => {
    it("sans 'members.read' : forbidden, sans toucher à la base", async () => {
        const { host } = fakeHost();
        await assert.rejects(
            createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).membersFor(4).list(),
            forbidden
        );
    });

    it('avec la capacité : le propriétaire compris, même sans ligne de membre', async () => {
        const { host } = fakeHost();
        const deps = createServiceDeps(host, manifest(ID, ['members.read']), null, NO_PROVIDERS, undefined);
        assert.deepEqual(await deps.membersFor(4).list(), [
            { userId: 7, name: 'alice', isOwner: true, color: 'blue' },
            { userId: 9, name: 'bob', isOwner: false, color: null }
        ]);
        assert.deepEqual(await deps.membersFor(5).list(), []);
    });
});

describe('createServiceDeps : accounts', () => {
    it("sans 'accounts.read' : forbidden sur search, sans toucher à la base", async () => {
        const { host, searchCalls } = fakeHost();
        const { accounts } = createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined);
        await assert.rejects(accounts.search('alice'), forbidden);
        assert.deepEqual(searchCalls, []);
    });

    it('avec la capacité : requête rognée, limite bornée ici, compte traduit', async () => {
        const { host, searchCalls } = fakeHost();
        const { accounts } = createServiceDeps(host, manifest(ID, ['accounts.read']), null, NO_PROVIDERS, undefined);
        assert.deepEqual(await accounts.search('  alice '), [
            {
                id: 7,
                email: 'alice@exemple.fr',
                username: 'alice',
                isAdmin: true,
                e2e: false,
                suspended: false,
                created: 12_000
            }
        ]);
        await accounts.search('', 999);
        await accounts.search('', 0);
        assert.deepEqual(searchCalls, [
            { query: 'alice', limit: 20 },
            { query: '', limit: 50 },
            { query: '', limit: 1 }
        ]);
    });

    it('all : gardé par la capacité, avec la suspension', async () => {
        const { host } = fakeHost();
        await assert.rejects(
            createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).accounts.all(),
            forbidden
        );
        const { accounts } = createServiceDeps(host, manifest(ID, ['accounts.read']), null, NO_PROVIDERS, undefined);
        assert.deepEqual(
            (await accounts.all()).map((a) => [a.id, a.suspended]),
            [[7, true]]
        );
    });

    it("usage : gardé par 'accounts.usage'", async () => {
        const { host } = fakeHost();
        const { usage } = createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined);
        await assert.rejects(usage.of(7), forbidden);
        await assert.rejects(usage.ofMany([7]), forbidden);
    });
});

describe('createServiceDeps : accountMail', () => {
    const message = {
        subject: 'Votre abonnement\r\nBcc: x@exemple.fr',
        paragraphs: ['Bonjour <alice>,'],
        notice: 'Date limite : le 14 octobre',
        button: { label: 'Gérer', url: 'https://deveye.test/?account=x' }
    };

    it("sans 'accounts.mail' : forbidden, rien ne part", async () => {
        const { host, sent } = fakeHost();
        const { accountMail } = createServiceDeps(host, manifest(ID, ['accounts.read']), null, NO_PROVIDERS, undefined);
        await assert.rejects(accountMail.send(7, message), forbidden);
        assert.deepEqual(sent, []);
    });

    it("à l'adresse du compte seulement, sujet sur une ligne, contenu échappé et encadré", async () => {
        const { host, sent } = fakeHost();
        const { accountMail } = createServiceDeps(host, manifest(ID, ['accounts.mail']), null, NO_PROVIDERS, undefined);
        assert.equal(await accountMail.send(7, message), 'alice@exemple.fr');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].to, 'alice@exemple.fr');
        assert.equal(sent[0].subject, 'Votre abonnement Bcc: x@exemple.fr');
        assert.match(sent[0].html, /Bonjour &lt;alice&gt;,/);
        assert.match(sent[0].html, /border:2px solid[^>]*>Date limite : le 14 octobre</);
        assert.match(sent[0].text, /----------\nDate limite : le 14 octobre\n----------/);
        assert.match(sent[0].text, /Gérer : https:\/\/deveye\.test\/\?account=x/);
    });

    it('compte inconnu : not_found ; sans SMTP : conflict, et `configured` le dit', async () => {
        const { host, sent, mailer } = fakeHost();
        const { accountMail } = createServiceDeps(host, manifest(ID, ['accounts.mail']), null, NO_PROVIDERS, undefined);
        await assert.rejects(accountMail.send(9, message), { name: 'FeatureError', code: 'not_found' });
        mailer.configured = false;
        assert.equal(accountMail.configured, false);
        await assert.rejects(accountMail.send(7, message), { name: 'FeatureError', code: 'conflict' });
        assert.deepEqual(sent, []);
    });

    it("sendToAdmins : aux administrateurs actifs qu'on retrouve, sans SMTP : conflict", async () => {
        const { host, sent, mailer } = fakeHost();
        const { accountMail } = createServiceDeps(host, manifest(ID, ['accounts.mail']), null, NO_PROVIDERS, undefined);
        assert.deepEqual(await accountMail.sendToAdmins(message), ['alice@exemple.fr']);
        assert.deepEqual(
            sent.map((m) => m.to),
            ['alice@exemple.fr']
        );
        mailer.configured = false;
        await assert.rejects(accountMail.sendToAdmins(message), { name: 'FeatureError', code: 'conflict' });
    });
});

describe('createServiceDeps : audit', () => {
    it('signe système : uid 0, ip vide, info par défaut, la feature pour catégorie', () => {
        const { host, records } = fakeHost();
        createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).audit({
            action: 'x.tick',
            description: 'tour'
        });
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
        createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined).audit({
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
        createServiceDeps(host, manifest('cloudsync'), null, NO_PROVIDERS, undefined).audit({
            action: 'sync.run',
            description: 'run'
        });
        createServiceDeps(host, manifest('weather'), null, NO_PROVIDERS, undefined).audit({
            action: 'weather.refresh',
            description: 'r'
        });
        assert.deepEqual(
            records.map((r) => r.category),
            ['cloudSync', 'weather']
        );
    });
});

describe('createServiceDeps : le reste, sans session', () => {
    it('deveyeFor ne tend que notify', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID, ['notify']), null, NO_PROVIDERS, undefined);
        assert.deepEqual(Object.keys(deps.deveyeFor(1)), ['notify']);
    });

    it("storeFor est sessionless : lire une ligne 'private' lève locked", async () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null, NO_PROVIDERS, undefined);
        await assert.rejects(deps.storeFor(1).get('secret'), { name: 'FeatureError', code: 'locked' });
    });

    it('cipherFor est mémoïsé par espace, sans lire la base à la construction', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null, NO_PROVIDERS, undefined);
        assert.equal(deps.cipherFor(1), deps.cipherFor(1));
        assert.notEqual(deps.cipherFor(1), deps.cipherFor(2));
    });

    it('agents sans la capacité : lève avant de toucher au hub', () => {
        // À noter : ici une Error nue, là où la façade de requête (facade.ts)
        // lève un FeatureError `forbidden` pour la même faute.
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null, NO_PROVIDERS, undefined);
        assert.throws(() => deps.agents.isOnline('dev-1'), /declare 'agents'/);
        assert.throws(() => deps.agents.publishSyncState({} as never), /declare 'agents'/);
    });

    it('agents avec la capacité : le hub', () => {
        const deps = createServiceDeps(
            fakeHost().host,
            manifest('cloudsync', ['agents']),
            null,
            NO_PROVIDERS,
            undefined
        );
        assert.equal(deps.agents.isOnline('dev-1'), true);
        assert.equal(deps.agents.isOnline('dev-2'), false);
    });

    it('keys scelle sous la sous-clé du module et le contexte donné, null pour un blob étranger', () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null, NO_PROVIDERS, undefined);
        const sealed = deps.keys.sealBytes(new Uint8Array([1, 2, 3]), 'table:col:7');
        assert.equal(sealed, `sealed:module:${ID}:table:col:7:010203`);
        assert.deepEqual(deps.keys.openBytes(sealed, 'table:col:7'), Buffer.from([1, 2, 3]));
        assert.equal(deps.keys.openBytes(sealed, 'table:col:8'), null);
        assert.equal(deps.keys.openBytes('autre'), null);
    });

    it("keys : le blob d'un module ne s'ouvre pas chez un autre", () => {
        const host = fakeHost().host;
        const mine = createServiceDeps(host, manifest(ID), null, NO_PROVIDERS, undefined);
        const other = createServiceDeps(host, manifest('cloudsync'), null, NO_PROVIDERS, undefined);
        assert.equal(other.keys.openBytes(mine.keys.sealBytes(new Uint8Array([9]))), null);
    });

    it('listWorkspaceIds lit les ids de tous les espaces', async () => {
        const deps = createServiceDeps(fakeHost().host, manifest(ID), null, NO_PROVIDERS, undefined);
        assert.deepEqual(await deps.listWorkspaceIds(), [1, 4]);
    });
});
