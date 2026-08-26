import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import type { FeatureManifest, NativeCapability } from '@deveye/types/sdk';
import type { SdkCipher } from '@deveye/types/sdk/server';

import type { MonitorHub } from '@/agent/hub';
import type { Database } from '@/db';
import { createFacade } from './facade';
import { setSdkHub } from './host';

/**
 * La façade des natives : le SEUL chemin d'un module vers les données des
 * autres features, gardé membre par membre par `nativeCapabilities`.
 *
 * Deux choses à tenir : la garde vient AVANT tout accès (une base vide ne
 * doit même pas être touchée sans la capacité), et derrière la garde chaque
 * membre projette ce qu'il promet : `notify` route par la feature du module,
 * `mail` ne révèle que l'étage ouvert, `devices.authorize` a la sémantique
 * d'`authorizeDevice` (introuvable, puis appartenance sauf admin), `agents`
 * délègue au hub sous le même nom.
 */

const WS = 3;
const OWNER = 10;

function manifest(caps: readonly NativeCapability[]): FeatureManifest {
    return {
        id: 'x-facadetest',
        label: 'Façade',
        description: 'Module de test de la façade.',
        icon: 'test',
        category: 'daily',
        notifies: true,
        hasItems: false,
        shareTier: 'never',
        resources: [],
        commands: [],
        nativeCapabilities: caps
    };
}

/** Le chiffrement de l'étage ouvert, réduit à une étiquette `enc:`. */
const cipher: SdkCipher = {
    encrypt: async (plain) => `enc:${plain}`,
    decrypt: async (blob) => blob.slice(4),
    tryDecrypt: async (blob) => (blob.startsWith('enc:') ? blob.slice(4) : null)
};

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/** Le hub agents : présence figée, et chaque appel consigné sous son nom. */
const online = new Set(['dev-1']);
const hubCalls: { method: string; args: unknown[] }[] = [];
const outbound =
    (method: string) =>
    (deviceId: string, payload: unknown): boolean => {
        hubCalls.push({ method, args: [deviceId, payload] });
        return online.has(deviceId);
    };
const fanout =
    (method: string) =>
    (payload: unknown): void => {
        hubCalls.push({ method, args: [payload] });
    };
setSdkHub({
    isOnline: (deviceId: string) => online.has(deviceId),
    requestSyncConfig: outbound('requestSyncConfig'),
    requestSyncScan: outbound('requestSyncScan'),
    requestSyncPush: outbound('requestSyncPush'),
    requestSyncApplyChunk: outbound('requestSyncApplyChunk'),
    requestSyncApplyStart: outbound('requestSyncApplyStart'),
    requestSyncApplyDir: outbound('requestSyncApplyDir'),
    requestSyncApplyLocal: outbound('requestSyncApplyLocal'),
    requestSyncMove: outbound('requestSyncMove'),
    requestSyncDelete: outbound('requestSyncDelete'),
    publishSyncProgress: fanout('publishSyncProgress'),
    publishSyncState: fanout('publishSyncState')
} as unknown as MonitorHub);

const OUTBOUND = [
    'requestSyncConfig',
    'requestSyncScan',
    'requestSyncPush',
    'requestSyncApplyChunk',
    'requestSyncApplyStart',
    'requestSyncApplyDir',
    'requestSyncApplyLocal',
    'requestSyncMove',
    'requestSyncDelete'
] as const;
const FANOUT = ['publishSyncProgress', 'publishSyncState'] as const;

/** Une base partielle : seuls les repos que le test attend sont là. */
function facadeWith(caps: readonly NativeCapability[], db: object = {}, isAdmin = false) {
    return createFacade({
        db: db as Database,
        cipher,
        workspaceId: WS,
        ownerUserId: OWNER,
        isAdmin,
        manifest: manifest(caps),
        logger
    });
}

const forbidden = { name: 'FeatureError', code: 'forbidden' };

/** Remplace `fetch` le temps d'un appel : la livraison d'un webhook ne sort jamais du test. */
async function withFetch<T>(run: () => Promise<T>): Promise<{ result: T; calls: { url: string; body: unknown }[] }> {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
        return { result: await run(), calls };
    } finally {
        globalThis.fetch = original;
    }
}

describe('createFacade : la garde des capacités', () => {
    // Base VIDE exprès : un accès avant la garde serait une TypeError, pas un forbidden.
    const facade = facadeWith([]);

    it('notify : hasRoute et send', async () => {
        await assert.rejects(facade.notify.hasRoute(), forbidden);
        await assert.rejects(facade.notify.send({ subject: 's', body: 'b' }), forbidden);
    });

    it('mail.listAccounts', async () => {
        await assert.rejects(facade.mail.listAccounts(), forbidden);
    });

    it('members.list', async () => {
        await assert.rejects(facade.members.list(), forbidden);
    });

    it('devices : authorize, list, isOnline', async () => {
        await assert.rejects(facade.devices.authorize('dev-1'), forbidden);
        await assert.rejects(facade.devices.list(), forbidden);
        assert.throws(() => facade.devices.isOnline('dev-1'), forbidden);
    });

    it('agents : isOnline, les neuf requêtes sortantes et le fan-out, sans toucher au hub', () => {
        const before = hubCalls.length;
        assert.throws(() => facade.agents.isOnline('dev-1'), forbidden);
        for (const name of OUTBOUND) assert.throws(() => facade.agents[name]('dev-1', {} as never), forbidden);
        for (const name of FANOUT) assert.throws(() => facade.agents[name]({} as never), forbidden);
        assert.equal(hubCalls.length, before);
    });

    it('le message nomme la capacité à déclarer', async () => {
        await assert.rejects(facade.mail.listAccounts(), /Declare 'mail\.accounts'/);
        await assert.rejects(facade.members.list(), /Declare 'members\.read'/);
        assert.throws(() => facade.agents.isOnline('dev-1'), /Declare 'agents'/);
    });
});

describe('createFacade : notify', () => {
    const route = { id: 51, workspace_id: WS, feature: 'x-facadetest', item_id: 0 };
    const webhook = {
        id: 7,
        workspace_id: WS,
        feature: 'x-facadetest',
        kind: 'webhook',
        label_enc: 'enc:Salon',
        target_enc: 'enc:https://hooks.example.test/abc',
        mail_account_id: null,
        enabled: 1,
        position: 0,
        created: 0
    };
    function dbWith(routed: boolean) {
        const findRouteCalls: unknown[][] = [];
        const db = {
            notificationChannels: {
                findRoute: async (...args: unknown[]) => {
                    findRouteCalls.push(args);
                    return routed ? route : null;
                },
                routeChannelIds: async () => [webhook.id],
                list: async () => [webhook]
            }
        };
        return { db, findRouteCalls };
    }

    it('hasRoute : faux sans route, vrai avec un canal exploitable', async () => {
        assert.equal(await facadeWith(['notify'], dbWith(false).db).notify.hasRoute(), false);
        assert.equal(await facadeWith(['notify'], dbWith(true).db).notify.hasRoute(), true);
    });

    it("la route est cherchée pour LA feature du module, sur l'élément demandé (0 = la feature)", async () => {
        const { db, findRouteCalls } = dbWith(false);
        const facade = facadeWith(['notify'], db);
        await facade.notify.hasRoute();
        await facade.notify.hasRoute(42);
        await facade.notify.send({ subject: 's', body: 'b' }, { itemId: 42 });
        assert.deepEqual(findRouteCalls, [
            [WS, 'x-facadetest', 0],
            [WS, 'x-facadetest', 42],
            [WS, 'x-facadetest', 42]
        ]);
    });

    it('send : faux sans route, sans rien livrer', async () => {
        const { result, calls } = await withFetch(() =>
            facadeWith(['notify'], dbWith(false).db).notify.send({ subject: 's', body: 'b' })
        );
        assert.equal(result, false);
        assert.deepEqual(calls, []);
    });

    it('send : livre au webhook routé, avec `{ feature }` comme charge par défaut', async () => {
        const { result, calls } = await withFetch(() =>
            facadeWith(['notify'], dbWith(true).db).notify.send({ subject: 'Alerte', body: 'corps' })
        );
        assert.equal(result, true);
        assert.deepEqual(calls, [
            {
                url: 'https://hooks.example.test/abc',
                body: { content: 'corps', text: 'corps', feature: 'x-facadetest' }
            }
        ]);
    });

    it('send : une charge fournie remplace la charge par défaut', async () => {
        const { calls } = await withFetch(() =>
            facadeWith(['notify'], dbWith(true).db).notify.send({
                subject: 'Alerte',
                body: 'corps',
                payload: { job: 1 }
            })
        );
        assert.deepEqual(calls[0]?.body, { content: 'corps', text: 'corps', job: 1 });
    });
});

describe('createFacade : mail.listAccounts', () => {
    it("ne révèle que les comptes de l'étage ouvert, métadonnées seulement", async () => {
        const asked: number[] = [];
        const db = {
            mailAccounts: {
                listByWorkspace: async (ws: number) => {
                    asked.push(ws);
                    return [
                        {
                            id: 1,
                            security_tier: 'open',
                            display_name_enc: 'enc:Perso',
                            email_address_enc: 'enc:me@example.test'
                        },
                        {
                            id: 2,
                            security_tier: 'guarded',
                            display_name_enc: 'enc:Pro',
                            email_address_enc: 'enc:pro@example.test'
                        },
                        { id: 3, security_tier: 'open', display_name_enc: 'illisible', email_address_enc: 'illisible' }
                    ];
                }
            }
        };
        const accounts = await facadeWith(['mail.accounts'], db).mail.listAccounts();
        assert.deepEqual(asked, [WS]);
        assert.deepEqual(accounts, [
            { id: 1, label: 'Perso', address: 'me@example.test' },
            { id: 3, label: 'Compte 3', address: null }
        ]);
    });
});

describe('createFacade : members.list', () => {
    it("le propriétaire d'abord, chaque membre une fois, isOwner sur le bon", async () => {
        let asked: number[] = [];
        const db = {
            workspaceMembers: {
                listByWorkspaceIds: async () => [{ user_id: 11 }, { user_id: OWNER }, { user_id: 11 }]
            },
            users: {
                findByIds: async (ids: number[]) => {
                    asked = ids;
                    return ids.map((id) => ({ id, username: `u${id}` }));
                }
            }
        };
        const members = await facadeWith(['members.read'], db).members.list();
        assert.deepEqual(asked, [OWNER, 11]);
        assert.deepEqual(members, [
            { userId: OWNER, name: 'u10', isOwner: true },
            { userId: 11, name: 'u11', isOwner: false }
        ]);
    });
});

describe('createFacade : devices', () => {
    const rows = [
        { id: 'dev-1', name: 'Portable' },
        { id: 'dev-2', name: 'Serveur' }
    ];
    function devicesDb(membership: Record<string, boolean>) {
        const hasWorkspaceCalls: [string, number][] = [];
        const db = {
            devices: {
                findById: async (id: string) => rows.find((r) => r.id === id) ?? null,
                hasWorkspace: async (id: string, ws: number) => {
                    hasWorkspaceCalls.push([id, ws]);
                    return membership[id] ?? false;
                },
                listByWorkspace: async () => rows
            }
        };
        return { db, hasWorkspaceCalls };
    }

    it('authorize : not_found quand la ligne manque', async () => {
        const { db } = devicesDb({});
        await assert.rejects(facadeWith(['devices.read'], db).devices.authorize('dev-9'), {
            name: 'FeatureError',
            code: 'not_found'
        });
    });

    it("authorize : forbidden quand l'appareil ne relève pas de cet espace", async () => {
        const { db, hasWorkspaceCalls } = devicesDb({ 'dev-1': false });
        await assert.rejects(facadeWith(['devices.read'], db).devices.authorize('dev-1'), forbidden);
        assert.deepEqual(hasWorkspaceCalls, [['dev-1', WS]]);
    });

    it("authorize : l'admin global passe outre l'appartenance, sans même la consulter", async () => {
        const { db, hasWorkspaceCalls } = devicesDb({ 'dev-1': false });
        const device = await facadeWith(['devices.read'], db, true).devices.authorize('dev-1');
        assert.deepEqual(device, { id: 'dev-1', name: 'Portable', online: true });
        assert.deepEqual(hasWorkspaceCalls, []);
    });

    it("authorize : l'appareil de l'espace, avec sa présence", async () => {
        const { db } = devicesDb({ 'dev-2': true });
        const device = await facadeWith(['devices.read'], db).devices.authorize('dev-2');
        assert.deepEqual(device, { id: 'dev-2', name: 'Serveur', online: false });
    });

    it("list : les appareils de l'espace, avec leur présence", async () => {
        const { db } = devicesDb({});
        assert.deepEqual(await facadeWith(['devices.read'], db).devices.list(), [
            { id: 'dev-1', name: 'Portable', online: true },
            { id: 'dev-2', name: 'Serveur', online: false }
        ]);
    });

    it('isOnline : la présence du hub', () => {
        const facade = facadeWith(['devices.read']);
        assert.equal(facade.devices.isOnline('dev-1'), true);
        assert.equal(facade.devices.isOnline('dev-2'), false);
    });
});

describe('createFacade : agents (capacité déclarée)', () => {
    const facade = facadeWith(['agents']);

    it('isOnline : la présence du hub', () => {
        assert.equal(facade.agents.isOnline('dev-1'), true);
        assert.equal(facade.agents.isOnline('dev-9'), false);
    });

    it('chaque requête sortante délègue au hub sous le même nom, et rend sa réponse', () => {
        for (const name of OUTBOUND) {
            const payload = { name };
            assert.equal(facade.agents[name]('dev-1', payload as never), true, name);
            assert.equal(facade.agents[name]('dev-9', payload as never), false, name);
            assert.deepEqual(hubCalls.slice(-2), [
                { method: name, args: ['dev-1', payload] },
                { method: name, args: ['dev-9', payload] }
            ]);
        }
    });

    it('le fan-out navigateurs délègue au hub sous le même nom', () => {
        for (const name of FANOUT) {
            const payload = { name };
            facade.agents[name](payload as never);
            assert.deepEqual(hubCalls.at(-1), { method: name, args: [payload] });
        }
    });
});
