import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from 'pino';
import { MAIL_TRANSPORT_PROVIDER, type FeatureManifest, type NativeCapability } from '@deveye/types/sdk';
import type { MailTransportProvider } from '@deveye/types/sdk';
import type { SdkCipher } from '@deveye/types/sdk/server';

import type { MonitorHub } from '@/agent/hub';
import type { Database } from '@/db';
import type { LiveHub } from '@/live/hub';
import { createFacade } from './facade';
import { setSdkHost } from './host';
import { setSafeFetchTransportForTest } from '@/Services/netFetch';
import { Response } from 'undici';

/**
 * La façade des natives, gardée membre par membre par `nativeCapabilities` :
 * la garde vient avant tout accès (une base vide ne doit même pas être
 * touchée), et derrière elle chaque membre projette ce qu'il promet.
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
setSdkHost(
    {
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
    } as unknown as MonitorHub,
    {} as Database,
    { publishFeature: () => undefined } as unknown as LiveHub
);

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

/** Une base partielle : seuls les repos que le test attend sont là ; de même pour les contrats tenus. */
function facadeWith(
    caps: readonly NativeCapability[],
    db: object = {},
    isAdmin = false,
    providers: Readonly<Record<string, unknown>> = {}
) {
    return createFacade({
        db: db as Database,
        cipher,
        workspaceId: WS,
        userId: OWNER,
        ownerUserId: OWNER,
        isAdmin,
        workspaceKind: isAdmin ? 'personal' : 'shared',
        manifest: manifest(caps),
        logger,
        providers: { get: <T>(key: string) => providers[key] as T | undefined }
    });
}

const forbidden = { name: 'FeatureError', code: 'forbidden' };

/** Remplace `fetch` le temps d'un appel : la livraison d'un webhook ne sort jamais du test. */
async function withFetch<T>(run: () => Promise<T>): Promise<{ result: T; calls: { url: string; body: unknown }[] }> {
    const calls: { url: string; body: unknown }[] = [];
    setSafeFetchTransportForTest(async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
    });
    try {
        return { result: await run(), calls };
    } finally {
        setSafeFetchTransportForTest(null);
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
    it("rend les expéditeurs prêts du module Mail, pour l'espace de la façade", async () => {
        const asked: number[] = [];
        const transport: MailTransportProvider = {
            listSenders: async (ws) => {
                asked.push(ws);
                return [{ id: 1, label: 'Perso', address: 'me@example.test' }];
            },
            isReady: async () => true,
            send: async () => true
        };
        const accounts = await facadeWith(['mail.accounts'], {}, false, {
            [MAIL_TRANSPORT_PROVIDER]: transport
        }).mail.listAccounts();
        assert.deepEqual(asked, [WS]);
        assert.deepEqual(accounts, [{ id: 1, label: 'Perso', address: 'me@example.test' }]);
    });

    it('sans module Mail, aucun compte : la capacité dégrade, elle ne lève pas', async () => {
        assert.deepEqual(await facadeWith(['mail.accounts']).mail.listAccounts(), []);
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
                    return ids.map((id) => ({ id, username: `u${id}`, color: id === OWNER ? 'blue' : '' }));
                }
            }
        };
        const members = await facadeWith(['members.read'], db).members.list();
        assert.deepEqual(asked, [OWNER, 11]);
        // La couleur suit le compte ; un compte jamais colorié rend `null`.
        assert.deepEqual(members, [
            { userId: OWNER, name: 'u10', isOwner: true, color: 'blue' },
            { userId: 11, name: 'u11', isOwner: false, color: null }
        ]);
    });
});

describe('createFacade : devices', () => {
    /** Une ligne appareil réduite à ce que la façade lit. */
    const row = (id: string, name: string) => ({
        id,
        name,
        status: 'active',
        owner_id: 7,
        workspace_id: WS,
        metric_interval_seconds: null,
        report_json: null
    });
    const rows = [row('dev-1', 'Portable'), row('dev-2', 'Serveur')];
    /** `dev-3` habite un autre espace et n'y est pas projeté : invisible d'ici. */
    const elsewhere = row('dev-3', 'Ailleurs');
    /** Ce que la façade révèle d'une ligne : l'identité, la présence, l'état, le rapport. */
    const revealed = (id: string, name: string, online: boolean) => ({
        id,
        name,
        online,
        status: 'active',
        ownerUserId: 7,
        workspaceId: WS,
        metricIntervalSeconds: null,
        report: null
    });
    function devicesDb() {
        const findVisibleCalls: [string, number][] = [];
        const db = {
            devices: {
                findVisible: async (id: string, ws: number) => {
                    findVisibleCalls.push([id, ws]);
                    return rows.find((r) => r.id === id) ?? null;
                },
                listByWorkspace: async () => rows
            }
        };
        return { db, findVisibleCalls };
    }

    it("authorize : not_found quand l'appareil n'est pas visible d'ici", async () => {
        const { db, findVisibleCalls } = devicesDb();
        await assert.rejects(facadeWith(['devices.read'], db).devices.authorize(elsewhere.id), {
            name: 'FeatureError',
            code: 'not_found'
        });
        assert.deepEqual(findVisibleCalls, [[elsewhere.id, WS]]);
    });

    it("authorize : l'administrateur global n'y échappe pas", async () => {
        const { db } = devicesDb();
        await assert.rejects(facadeWith(['devices.read'], db, true).devices.authorize(elsewhere.id), {
            name: 'FeatureError',
            code: 'not_found'
        });
    });

    it("authorize : l'appareil de l'espace, avec sa présence", async () => {
        const { db } = devicesDb();
        const device = await facadeWith(['devices.read'], db).devices.authorize('dev-2');
        assert.deepEqual(device, revealed('dev-2', 'Serveur', false));
    });

    it("list : les appareils de l'espace, avec leur présence", async () => {
        const { db } = devicesDb();
        assert.deepEqual(await facadeWith(['devices.read'], db).devices.list(), [
            revealed('dev-1', 'Portable', true),
            revealed('dev-2', 'Serveur', false)
        ]);
    });

    it("list : l'administrateur global voit le même espace que les autres", async () => {
        const { db } = devicesDb();
        const listed = await facadeWith(['devices.read'], db, true).devices.list();
        assert.deepEqual(
            listed.map((d) => d.id),
            ['dev-1', 'dev-2']
        );
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

describe('createFacade : notify, le message vivant', () => {
    const route = { id: 51, workspace_id: WS, feature: 'x-facadetest', item_id: 0 };
    const discord = {
        id: 8,
        workspace_id: WS,
        feature: 'x-facadetest',
        kind: 'discord',
        label_enc: 'enc:Salon',
        target_enc: 'enc:https://discord.com/api/webhooks/1/abc',
        mail_account_id: null,
        enabled: 1,
        position: 0,
        created: 0
    };
    const webhook = { ...discord, id: 7, kind: 'webhook', target_enc: 'enc:https://hooks.example.test/abc' };
    const foreign = { ...discord, id: 9, feature: 'x-other' };
    const db = {
        notificationChannels: {
            findRoute: async () => route,
            routeChannelIds: async () => [webhook.id, discord.id],
            list: async () => [webhook, discord],
            findById: async (id: number) => [webhook, discord, foreign].find((c) => c.id === id) ?? null
        }
    };

    /** Un Discord factice : POST rend un identifiant, PATCH accepte, et tout est relevé. */
    async function withDiscord<T>(
        run: () => Promise<T>
    ): Promise<{ result: T; calls: { method: string; url: string }[] }> {
        const calls: { method: string; url: string }[] = [];
        setSafeFetchTransportForTest(async (url, init) => {
            calls.push({ method: init.method ?? 'GET', url });
            return init.method === 'POST'
                ? new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
                : new Response(null, { status: 204 });
        });
        try {
            return { result: await run(), calls };
        } finally {
            setSafeFetchTransportForTest(null);
        }
    }

    it('liveChannels ne liste que les canaux Discord de la route', async () => {
        assert.deepEqual(await facadeWith(['notify'], db).notify.liveChannels(), [{ id: 8 }]);
    });

    it('postLive publie sans identifiant, modifie avec, et rend celui à garder', async () => {
        const facade = facadeWith(['notify'], db);
        const { result: posted, calls } = await withDiscord(() =>
            facade.notify.postLive(8, { embeds: [{ title: 'En cours' }] })
        );
        assert.equal(posted, 'msg-1');
        const { result: edited, calls: edits } = await withDiscord(() =>
            facade.notify.postLive(8, { embeds: [{ title: 'Fini' }] }, 'msg-1')
        );
        assert.equal(edited, 'msg-1');
        assert.deepEqual(
            [...calls, ...edits].map((c) => c.method),
            ['POST', 'PATCH']
        );
    });

    it("postLive refuse un canal qui n'est pas Discord, ou pas celui de la feature", async () => {
        const facade = facadeWith(['notify'], db);
        const { result, calls } = await withDiscord(async () => [
            await facade.notify.postLive(7, { content: 'texte' }),
            await facade.notify.postLive(9, { content: 'texte' })
        ]);
        assert.deepEqual(result, [null, null]);
        assert.deepEqual(calls, []);
    });

    it("send écarte les canaux d'`except`, ceux dont le message vivant a conclu", async () => {
        const { calls } = await withFetch(() =>
            facadeWith(['notify'], db).notify.send({ subject: 's', body: 'b' }, { except: [8] })
        );
        assert.deepEqual(
            calls.map((c) => c.url),
            ['https://hooks.example.test/abc']
        );
    });
});
