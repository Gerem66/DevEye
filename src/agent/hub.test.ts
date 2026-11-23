import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WebSocket } from '@fastify/websocket';
import * as types from '@deveye/types';

import { accessEpochNow, invalidateAccess } from '@/features/_access';
import type { ServiceTask } from '@/Services/tasks';

import type { DeviceGrants } from './audience';
import { DEVICE_EVENT_AUDIENCES, MonitorHub } from './hub';

/** Ce qu'une socket d'agent reçoit, relu en clair ; le reste est inerte. */
function fakeAgent(): { socket: WebSocket; sent: { command: string; payload: Record<string, unknown> }[] } {
    const sent: { command: string; payload: Record<string, unknown> }[] = [];
    const socket = {
        send: (frame: string) => sent.push(JSON.parse(frame)),
        close: () => undefined,
        on: () => undefined,
        ping: () => undefined,
        terminate: () => undefined,
        bufferedAmount: 0
    } as unknown as WebSocket;
    return { socket, sent };
}

const DEVICE = 'dev-1';
const request = { opId: 'op-1', path: '/srv/www', exclusions: [], oneFileSystem: true };
const piece = (seq: number) => ({
    deviceId: DEVICE,
    opId: 'op-1',
    seq,
    data: Buffer.from(`p${seq}`).toString('base64')
});
const end = {
    deviceId: DEVICE,
    opId: 'op-1',
    ok: true,
    files: 3,
    dirs: 1,
    bytesRead: 42,
    skipped: 0,
    changed: 0,
    samples: []
};

/** Laisse le générateur avancer jusqu'à sa prochaine attente. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('MonitorHub : archive de dossier', () => {
    it('rend les crédits au rythme où le consommateur prend les pièces', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const archive = hub.openFolderArchive(DEVICE, request);
        const it = archive[Symbol.asyncIterator]();

        const first = it.next();
        await settle();
        assert.equal(agent.sent[0].command, 'files.archive');
        assert.equal(agent.sent[0].payload.window, 8);

        for (let seq = 0; seq < 8; seq++) hub.receiveArchiveChunk(DEVICE, agent.socket, piece(seq));
        assert.equal((await first).value?.toString(), 'p0');
        // Trois pièces prises : pas encore de crédit rendu.
        for (let i = 0; i < 2; i++) await it.next();
        assert.equal(agent.sent.filter((f) => f.command === 'files.archiveCredit').length, 0);
        await it.next();
        const credits = agent.sent.filter((f) => f.command === 'files.archiveCredit');
        assert.deepEqual(
            credits.map((f) => f.payload.credits),
            [4]
        );

        for (let i = 0; i < 4; i++) await it.next();
        const tail = it.next();
        hub.receiveArchiveEnd(DEVICE, agent.socket, end);
        assert.equal((await tail).done, true);
        assert.equal(archive.summary?.files, 3);
        // Une archive finie n'est pas annulée.
        assert.equal(agent.sent.filter((f) => f.command === 'files.archiveCancel').length, 0);
    });

    it('une pièce hors d’ordre ou au-delà des crédits fait échouer l’archive', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const it = hub.openFolderArchive(DEVICE, request)[Symbol.asyncIterator]();
        const next = it.next();
        await settle();
        hub.receiveArchiveChunk(DEVICE, agent.socket, piece(1));
        await assert.rejects(next, /hors d’ordre/);
        assert.ok(agent.sent.some((f) => f.command === 'files.archiveCancel'));

        const again = hub.openFolderArchive(DEVICE, request)[Symbol.asyncIterator]();
        const pending = again.next();
        await settle();
        for (let seq = 0; seq < 9; seq++) hub.receiveArchiveChunk(DEVICE, agent.socket, piece(seq));
        // Les huit premières sont là ; la neuvième dépassait la fenêtre.
        assert.equal((await pending).value?.toString(), 'p0');
        for (let i = 1; i < 8; i++) await again.next();
        await assert.rejects(again.next(), /hors d’ordre/);
    });

    it('quitter la boucle annule l’archive sur la machine', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const archive = hub.openFolderArchive(DEVICE, request);
        const consumer = (async () => {
            for await (const chunk of archive) {
                void chunk;
                break;
            }
        })();
        await settle();
        hub.receiveArchiveChunk(DEVICE, agent.socket, piece(0));
        await consumer;
        assert.ok(agent.sent.some((f) => f.command === 'files.archiveCancel' && f.payload.opId === 'op-1'));
    });

    it('une session qui tombe, même remplacée, emporte son archive', async () => {
        const hub = new MonitorHub();
        const first = fakeAgent();
        hub.agentOnline(DEVICE, first.socket);
        const it = hub.openFolderArchive(DEVICE, request)[Symbol.asyncIterator]();
        const next = it.next();
        await settle();

        // Reconnexion rapide : l'ancienne socket se ferme après coup.
        const second = fakeAgent();
        hub.agentOnline(DEVICE, second.socket);
        hub.agentOffline(DEVICE, first.socket);
        await assert.rejects(next, /déconnectée/);
        // Une pièce de l'ancienne session n'appartient à rien.
        hub.receiveArchiveChunk(DEVICE, first.socket, piece(0));
    });

    it('une machine hors ligne refuse d’emblée, et `signal` interrompt l’attente', async () => {
        const hub = new MonitorHub();
        await assert.rejects(hub.openFolderArchive(DEVICE, request)[Symbol.asyncIterator]().next(), /pas connectée/);

        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const controller = new AbortController();
        const it = hub.openFolderArchive(DEVICE, request, controller.signal)[Symbol.asyncIterator]();
        const next = it.next();
        await settle();
        controller.abort(new Error('Délai dépassé.'));
        await assert.rejects(next, /Délai dépassé/);
        assert.ok(agent.sent.some((f) => f.command === 'files.archiveCancel'));
    });

    it('une archive en échec rend la raison de la machine', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const it = hub.openFolderArchive(DEVICE, request)[Symbol.asyncIterator]();
        const next = it.next();
        await settle();
        hub.receiveArchiveEnd(DEVICE, agent.socket, { ...end, ok: false, error: 'résolution de /srv/www' });
        await assert.rejects(next, /résolution de \/srv\/www/);
    });
});

describe('MonitorHub : tunnel TCP', () => {
    /** Ouvre un tunnel et le confirme comme le ferait l'agent. */
    async function openedTunnel() {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const pending = hub.tunnels.open(DEVICE, { host: '127.0.0.1', port: 5432 });
        const order = agent.sent[0];
        assert.equal(order.command, 'tunnel.open');
        assert.equal(order.payload.window, 8);
        const tunnelId = order.payload.tunnelId as string;
        hub.tunnels.opened(DEVICE, agent.socket, { deviceId: DEVICE, tunnelId });
        return { hub, agent, tunnelId, stream: await pending };
    }

    const chunk = (tunnelId: string, text: string) => ({
        deviceId: DEVICE,
        tunnelId,
        data: Buffer.from(text).toString('base64')
    });

    it('relaie dans les deux sens et rend les crédits par paquets', async () => {
        const { hub, agent, tunnelId, stream } = await openedTunnel();
        for (let i = 0; i < 8; i++) hub.tunnels.data(DEVICE, agent.socket, chunk(tunnelId, `r${i}`));
        const read: string[] = [];
        stream.on('data', (b: Buffer) => read.push(b.toString()));
        await settle();
        assert.equal(read.join(''), 'r0r1r2r3r4r5r6r7');
        const credits = agent.sent.filter((f) => f.command === 'tunnel.credit').map((f) => f.payload.credits);
        assert.deepEqual(credits, [8]);

        await new Promise<void>((resolve, reject) =>
            stream.write(Buffer.alloc(70 * 1024, 1), (e) => (e ? reject(e) : resolve()))
        );
        const writes = agent.sent.filter((f) => f.command === 'tunnel.write');
        assert.equal(writes.length, 2, 'découpé en pièces de 64 Kio');

        stream.destroy();
        assert.equal(agent.sent.at(-1)?.command, 'tunnel.close');
    });

    it('rend le refus de la machine à l’ouverture', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const pending = hub.tunnels.open(DEVICE, { host: '10.0.0.5', port: 3306 });
        const tunnelId = agent.sent[0].payload.tunnelId as string;
        hub.tunnels.closed(DEVICE, agent.socket, { deviceId: DEVICE, tunnelId, error: 'cible refusée' });
        await assert.rejects(pending, /cible refusée/);
        assert.equal(agent.sent.filter((f) => f.command === 'tunnel.close').length, 0);
    });

    it('échoue quand la machine se déconnecte ou déborde de ses crédits', async () => {
        const first = await openedTunnel();
        const offline = new Promise<Error>((resolve) => first.stream.once('error', resolve));
        first.hub.agentOffline(DEVICE, first.agent.socket);
        assert.match((await offline).message, /déconnectée/);

        const second = await openedTunnel();
        const overflow = new Promise<Error>((resolve) => second.stream.once('error', resolve));
        for (let i = 0; i < 9; i++) second.hub.tunnels.data(DEVICE, second.agent.socket, chunk(second.tunnelId, 'x'));
        assert.match((await overflow).message, /plus que ce qui lui était permis/);
        assert.equal(second.agent.sent.at(-1)?.command, 'tunnel.close');
    });

    it('rejette sans machine connectée', async () => {
        await assert.rejects(new MonitorHub().tunnels.open(DEVICE, { host: '127.0.0.1', port: 5432 }), /pas connectée/);
    });
});

describe('MonitorHub : une machine ne répond que pour elle-même', () => {
    it('le verdict d’une opération de fichier ne vient que de sa machine', async () => {
        const hub = new MonitorHub();
        const waiting = hub.awaitFilesOp(DEVICE, 'op-f', 1000);
        hub.publishFilesOp({ deviceId: 'dev-other', opId: 'op-f', op: 'mkdir', ok: true });
        hub.publishFilesOp({ deviceId: DEVICE, opId: 'op-f', op: 'mkdir', ok: false, error: 'refus' });
        assert.deepEqual(await waiting, { ok: false, error: 'refus' });
    });

    it('le verdict d’une action Docker ne vient que de sa machine', async () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const lines: string[] = [];
        const verdict = hub.runDockerOp(
            DEVICE,
            { opId: 'op-d', engine: 'docker', action: 'restart', target: 'c1' },
            { timeoutMs: 1000, onLine: (line) => lines.push(line) }
        );
        hub.publishDockerProgress({ deviceId: 'dev-other', opId: 'op-d', line: 'faux' });
        hub.publishDockerDone({ deviceId: 'dev-other', opId: 'op-d', action: 'restart', ok: true });
        hub.publishDockerProgress({ deviceId: DEVICE, opId: 'op-d', line: 'vrai' });
        hub.publishDockerDone({ deviceId: DEVICE, opId: 'op-d', action: 'restart', ok: false, error: 'non' });
        assert.deepEqual(await verdict, { ok: false, error: 'non' });
        assert.deepEqual(lines, ['vrai']);
    });

    it('la fin d’une session de terminal ne vient que de sa machine', () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        const viewer = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        assert.ok(hub.requestTermOpen(viewer.socket, DEVICE, { sessionId: 's-1', cols: 80, rows: 24 }));
        hub.publishTermExit({ deviceId: 'dev-other', sessionId: 's-1', code: 0 });
        assert.ok(hub.ownsTermSession(viewer.socket, 's-1'));
        hub.publishTermExit({ deviceId: DEVICE, sessionId: 's-1', code: 0 });
        assert.ok(!hub.ownsTermSession(viewer.socket, 's-1'));
    });
});

describe('MonitorHub : agent en pause', () => {
    it('une session de contrôle reste hors ligne et ne reçoit que ce qui la concerne', () => {
        const hub = new MonitorHub();
        const control = fakeAgent();
        hub.agentPaused(DEVICE, control.socket);
        assert.equal(hub.isOnline(DEVICE), false);
        assert.equal(hub.isPaused(DEVICE), true);
        assert.deepEqual(hub.pausedDevices([DEVICE, 'dev-other']), { [DEVICE]: true, 'dev-other': false });
        assert.equal(hub.requestCollect(DEVICE), false, 'aucun travail ne part vers un agent en pause');
        assert.equal(hub.requestLifecycle(DEVICE, { action: 'pause' }), false, 'déjà en pause');
        assert.ok(hub.requestLifecycle(DEVICE, { action: 'resume' }));
        assert.ok(hub.requestLifecycle(DEVICE, { action: 'restart' }));
        assert.ok(hub.requestDestroy(DEVICE));
        assert.deepEqual(
            control.sent.map((f) => [f.command, f.payload.action]),
            [
                ['agent.lifecycle', 'resume'],
                ['agent.lifecycle', 'restart'],
                ['agent.destroy', undefined]
            ]
        );
        hub.pausedGone(DEVICE, control.socket);
        assert.equal(hub.isPaused(DEVICE), false);
        assert.equal(hub.requestLifecycle(DEVICE, { action: 'resume' }), false, 'plus personne à reprendre');
    });

    it('une session de travail et une session de contrôle ne coexistent jamais', () => {
        const hub = new MonitorHub();
        const closes: string[] = [];
        const control = fakeAgent();
        (control.socket as unknown as { close: () => void }).close = () => closes.push('control');
        hub.agentPaused(DEVICE, control.socket);
        const working = fakeAgent();
        (working.socket as unknown as { close: () => void }).close = () => closes.push('working');
        hub.agentOnline(DEVICE, working.socket);
        assert.deepEqual(closes, ['control']);
        assert.ok(hub.isOnline(DEVICE) && !hub.isPaused(DEVICE));
        // L'agent se met en pause : sa session de travail encore ouverte est fermée.
        const control2 = fakeAgent();
        hub.agentPaused(DEVICE, control2.socket);
        assert.deepEqual(closes, ['control', 'working']);
        hub.agentOffline(DEVICE, working.socket);
        assert.ok(!hub.isOnline(DEVICE) && hub.isPaused(DEVICE));
        assert.equal(hub.disconnectAgent(DEVICE), true, 'révoquer coupe aussi la session de contrôle');
    });
});

describe('MonitorHub : l’opération que suit un verrou', () => {
    /** La poignée d'une opération de la zone, réduite à ce qu'on lui a dit. */
    function task() {
        const said: unknown[] = [];
        const handle: ServiceTask = {
            id: 'task-1',
            progress: (update) => void said.push(update),
            done: (note) => void said.push({ done: note }),
            fail: (message, code) => void said.push({ fail: message, code }),
            cancelled: () => void said.push('cancelled')
        };
        return { handle, said };
    }

    it('nourrit et solde l’opération d’une mise à jour de paquets', () => {
        const hub = new MonitorHub();
        const { handle, said } = task();
        hub.beginUpgrade(DEVICE, 'apt');
        hub.followUpgrade(DEVICE, 'apt', handle);

        hub.publishPackageProgress({ deviceId: DEVICE, manager: 'apt', line: 'Unpacking curl', percent: 40.4 });
        hub.publishPackageProgress({ deviceId: DEVICE, manager: 'dnf', line: 'autre outil' });
        hub.publishPackageDone({ deviceId: DEVICE, manager: 'apt', ok: true, rebootRequired: true });
        hub.publishPackageDone({ deviceId: DEVICE, manager: 'apt', ok: false, error: 'tard' });

        assert.deepEqual(said, [
            { step: 'Unpacking curl', done: 40, total: 100 },
            { done: 'Mise à jour terminée : un redémarrage est demandé.' }
        ]);
    });

    it('dit l’échec d’une machine qui s’en va au milieu d’une action longue', () => {
        const hub = new MonitorHub();
        const { handle, said } = task();
        hub.beginDockerOp(DEVICE, 'op-9', 'pruneImages');
        hub.followDockerOp(DEVICE, 'op-9', handle);

        hub.publishDockerProgress({ deviceId: DEVICE, opId: 'op-9', line: 'Deleted: sha256:abc' });
        hub.failRunningDockerOp(DEVICE, 'L’agent s’est déconnecté.');

        assert.deepEqual(said, [
            { step: 'Deleted: sha256:abc' },
            { fail: 'L’agent s’est déconnecté.', code: 'conflict' }
        ]);
        assert.equal(hub.runningDockerOp(DEVICE), null);
    });
});

/** Ce qu'un navigateur abonné reçoit, par nom d'événement. */
function fakeBrowser(): { socket: WebSocket; got: string[]; data: unknown[] } {
    const got: string[] = [];
    const data: unknown[] = [];
    const socket = {
        send: (frame: string) => {
            const parsed = JSON.parse(frame) as { command: string; payload: { data: unknown } };
            got.push(parsed.command);
            data.push(parsed.payload.data);
        },
        bufferedAmount: 0
    } as unknown as WebSocket;
    return { socket, got, data };
}

const WORKSPACE = 1;

const held = (over: Partial<DeviceGrants> = {}): DeviceGrants => ({
    read: true,
    write: false,
    admin: false,
    extras: new Set<string>(),
    access: new Map(),
    itemExtras: new Map(),
    ...over
});

const EVERYTHING = held({
    write: true,
    admin: true,
    extras: new Set(['terminal', 'files', 'logs', 'docker', 'network', 'system'])
});

/** Un navigateur qui suit la machine avec ces droits. */
function watching(hub: MonitorHub, grants: DeviceGrants): ReturnType<typeof fakeBrowser> {
    const browser = fakeBrowser();
    hub.subscribe(browser.socket, WORKSPACE, [DEVICE]);
    hub.rememberGrants(browser.socket, WORKSPACE, { devices: grants, cloudSync: false }, accessEpochNow());
    return browser;
}

function onlineHub(): MonitorHub {
    const hub = new MonitorHub();
    hub.agentOnline(DEVICE, fakeAgent().socket);
    return hub;
}

/** Tout ce que le hub diffuse comme état partagé, charge utile réduite au nécessaire. */
function publishShared(hub: MonitorHub): void {
    hub.publishMetric(DEVICE, {} as never);
    hub.publishReport(DEVICE, {} as never);
    hub.publishDockerInventory({ deviceId: DEVICE, inventory: {} } as never);
    hub.publishDockerStats({ deviceId: DEVICE } as never);
    hub.publishDockerProgress({ deviceId: DEVICE, opId: 'd1', line: 'pull' });
    hub.publishDockerDone({ deviceId: DEVICE, opId: 'd1', action: 'pruneImages', ok: true });
    hub.publishPackageList({ deviceId: DEVICE, managers: [] } as never);
    hub.publishPackageCount({ deviceId: DEVICE, manager: 'apt', count: 2 } as never);
    hub.publishPackageStarted({ deviceId: DEVICE, manager: 'apt' } as never);
    hub.publishPackageProgress({ deviceId: DEVICE, manager: 'apt', line: 'curl' });
    hub.publishPackageDone({ deviceId: DEVICE, manager: 'apt', ok: true });
    hub.publishPower({ deviceId: DEVICE, action: 'reboot', ok: true } as never);
    hub.publishService({ deviceId: DEVICE, action: 'elevate', ok: true } as never);
}

const TELEMETRY = ['metrics.push', 'device.report'];
const DOCKER_EVENTS = ['device.dockerInventory', 'device.dockerStats', 'device.dockerProgress', 'device.dockerDone'];
const SYSTEM_EVENTS = [
    'package.list',
    'package.count',
    'package.started',
    'package.progress',
    'package.done',
    'device.powerResult'
];

describe('MonitorHub : qui reçoit ce qu’une machine renvoie', () => {
    it('un état partagé ne va qu’à ceux qui tiennent la permission de l’ordre', () => {
        const hub = onlineHub();
        const owner = watching(hub, EVERYTHING);
        const docker = watching(hub, held({ extras: new Set(['docker']) }));
        const system = watching(hub, held({ extras: new Set(['system']) }));
        const reader = watching(hub, held());

        publishShared(hub);

        assert.deepEqual(reader.got, TELEMETRY);
        assert.deepEqual(docker.got, [...TELEMETRY, ...DOCKER_EVENTS]);
        assert.deepEqual(system.got, [...TELEMETRY, ...SYSTEM_EVENTS]);
        assert.deepEqual(owner.got, [...TELEMETRY, ...DOCKER_EVENTS, ...SYSTEM_EVENTS, 'device.serviceResult']);
    });

    it('le résultat d’un changement de service demande l’administrateur et l’écriture', () => {
        const hub = onlineHub();
        const admin = watching(hub, held({ admin: true }));
        const writer = watching(hub, held({ write: true }));
        const both = watching(hub, held({ admin: true, write: true }));

        hub.publishService({ deviceId: DEVICE, action: 'elevate', ok: true } as never);

        assert.deepEqual(admin.got, []);
        assert.deepEqual(writer.got, []);
        assert.deepEqual(both.got, ['device.serviceResult']);
    });

    it('la surcharge d’une machine remplace ce que le rôle accorde, dans les deux sens', () => {
        const hub = onlineHub();
        const raised = watching(hub, held({ itemExtras: new Map([[DEVICE, { docker: true }]]) }));
        const lowered = watching(
            hub,
            held({ extras: new Set(['docker']), itemExtras: new Map([[DEVICE, { docker: false }]]) })
        );
        const readOnly = watching(hub, held({ extras: new Set(['docker']), access: new Map([[DEVICE, 'read']]) }));
        const hidden = watching(hub, held({ extras: new Set(['docker']), access: new Map([[DEVICE, 'none']]) }));

        hub.publishMetric(DEVICE, {} as never);
        hub.publishDockerStats({ deviceId: DEVICE } as never);

        assert.deepEqual(raised.got, ['metrics.push', 'device.dockerStats']);
        assert.deepEqual(lowered.got, ['metrics.push']);
        assert.deepEqual(readOnly.got, ['metrics.push']);
        assert.deepEqual(hidden.got, []);
    });

    it('un instantané d’avant le dernier changement d’accès ne reçoit rien', () => {
        const hub = onlineHub();
        const stale = fakeBrowser();
        hub.subscribe(stale.socket, WORKSPACE, [DEVICE]);
        hub.rememberGrants(stale.socket, WORKSPACE, { devices: EVERYTHING, cloudSync: false }, accessEpochNow() - 1);

        publishShared(hub);

        assert.deepEqual(stale.got, []);
    });

    it('chaque événement d’appareil des types a une audience déclarée', () => {
        const events = Object.entries(types)
            .filter(([name]) => /^(DEVICE|PACKAGE|METRICS)_\w+_EVENT$/.test(name))
            .map(([, value]) => value as string);
        assert.ok(events.length >= 23);
        for (const event of events) {
            assert.ok(event in DEVICE_EVENT_AUDIENCES, `${event} n’a pas d’audience`);
        }
    });
});

describe('MonitorHub : la réponse d’une opération va à qui l’a demandée', () => {
    const FILES_HOLDER = held({ extras: new Set(['files', 'logs']) });

    it('une liste, une recherche et un téléchargement ne vont qu’à la socket demandeuse', () => {
        const hub = onlineHub();
        const asker = watching(hub, FILES_HOLDER);
        const other = watching(hub, FILES_HOLDER);

        assert.equal(hub.requestFilesList(DEVICE, { opId: 'l1', path: '/etc' }, asker.socket), true);
        hub.publishFilesListing({ deviceId: DEVICE, opId: 'l1', listing: null });
        hub.publishFilesListing({ deviceId: DEVICE, opId: 'l1', listing: null });

        assert.equal(hub.requestFilesSearch(DEVICE, { opId: 's1', path: '/etc' } as never, asker.socket), true);
        hub.publishFilesMatches({ deviceId: DEVICE, opId: 's1', matches: [], truncated: false });

        assert.equal(hub.requestFilesDownload(DEVICE, { opId: 'g1', path: '/etc/hosts' }, asker.socket), true);
        hub.publishFilesChunk({ deviceId: DEVICE, opId: 'g1', data: 'YQ==', done: false });
        hub.publishFilesChunk({ deviceId: DEVICE, opId: 'g1', data: '', done: true });
        hub.publishFilesChunk({ deviceId: DEVICE, opId: 'g1', data: 'Yg==', done: false });

        assert.deepEqual(asker.got, [
            'device.filesListing',
            'device.filesMatches',
            'device.filesChunk',
            'device.filesChunk'
        ]);
        assert.deepEqual(other.got, []);
    });

    it('une lecture de journal et l’inventaire des sources vont à qui les a demandés', () => {
        const hub = onlineHub();
        const asker = watching(hub, FILES_HOLDER);
        const other = watching(hub, FILES_HOLDER);

        assert.equal(hub.requestLogSources(DEVICE, asker.socket), true);
        hub.publishLogSources({ deviceId: DEVICE, sources: [] });
        hub.publishLogSources({ deviceId: DEVICE, sources: [] });

        assert.equal(hub.requestLogQuery(DEVICE, { queryId: 'q1', sourceId: 'journal' }, asker.socket), true);
        hub.publishLogLines({ deviceId: DEVICE, queryId: 'q1', lines: [], done: false });
        hub.publishLogLines({ deviceId: DEVICE, queryId: 'q1', lines: [], done: true });
        hub.publishLogLines({ deviceId: DEVICE, queryId: 'q1', lines: [], done: true });

        assert.deepEqual(asker.got, ['device.logSources', 'device.logLines', 'device.logLines']);
        assert.deepEqual(other.got, []);
    });

    it('un identifiant déjà tenu par une autre socket est refusé', () => {
        const hub = onlineHub();
        const first = watching(hub, FILES_HOLDER);
        const second = watching(hub, FILES_HOLDER);

        assert.equal(hub.requestFilesDownload(DEVICE, { opId: 'g1', path: '/etc/hosts' }, first.socket), true);
        assert.equal(hub.requestFilesDownload(DEVICE, { opId: 'g1', path: '/etc/shadow' }, second.socket), false);
        // Les morceaux d'un même envoi reprennent l'identifiant de leur socket.
        assert.equal(hub.requestFilesDownload(DEVICE, { opId: 'g1', path: '/etc/hosts' }, first.socket), true);

        hub.publishFilesChunk({ deviceId: DEVICE, opId: 'g1', data: 'YQ==', done: true });
        assert.deepEqual(first.got, ['device.filesChunk']);
        assert.deepEqual(second.got, []);
    });

    it('qui a perdu la permission entre la demande et la réponse ne reçoit rien', () => {
        const hub = onlineHub();
        const asker = watching(hub, FILES_HOLDER);

        hub.requestFilesList(DEVICE, { opId: 'l1', path: '/etc' }, asker.socket);
        hub.rememberGrants(asker.socket, WORKSPACE, { devices: held(), cloudSync: false }, accessEpochNow());
        hub.publishFilesListing({ deviceId: DEVICE, opId: 'l1', listing: null });

        assert.deepEqual(asker.got, []);
    });

    it('une socket fermée ou une machine partie solde ses opérations', () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const gone = watching(hub, FILES_HOLDER);
        const next = watching(hub, FILES_HOLDER);

        hub.requestFilesList(DEVICE, { opId: 'l1', path: '/etc' }, gone.socket);
        hub.dropSubscriber(gone.socket);
        assert.equal(hub.requestFilesList(DEVICE, { opId: 'l1', path: '/srv' }, next.socket), true);

        hub.agentOffline(DEVICE, agent.socket);
        hub.agentOnline(DEVICE, agent.socket);
        hub.publishFilesListing({ deviceId: DEVICE, opId: 'l1', listing: null });

        assert.deepEqual(gone.got, []);
        assert.deepEqual(
            next.got.filter((command) => command === 'device.filesListing'),
            []
        );
    });

    it('une opération lancée par le serveur ne va à aucun navigateur', async () => {
        const hub = onlineHub();
        const browser = watching(hub, EVERYTHING);

        const verdict = hub.awaitFilesOp(DEVICE, 'b1', 1000);
        assert.equal(hub.requestFilesMutate(DEVICE, { opId: 'b1', op: 'mkdir', path: '/backup' }), true);
        hub.publishFilesOp({ deviceId: DEVICE, opId: 'b1', op: 'mkdir', ok: true });

        assert.deepEqual(await verdict, { ok: true, error: undefined });
        assert.deepEqual(browser.got, []);
    });
});

describe('MonitorHub : un instantané périmé se recalcule', () => {
    const TERM_HOLDER = held({ extras: new Set(['terminal']) });

    /** Un recalcul que le test laisse aboutir quand il le décide, sous les droits qu'il choisit. */
    function refresherOf(hub: MonitorHub, browser: ReturnType<typeof fakeBrowser>) {
        const calls: number[] = [];
        let release: (grants: DeviceGrants) => void = () => undefined;
        hub.setRefresher(browser.socket, (workspaceId) => {
            calls.push(workspaceId);
            const epoch = accessEpochNow();
            return new Promise<void>((resolve) => {
                release = (grants) => {
                    hub.rememberGrants(browser.socket, workspaceId, { devices: grants, cloudSync: false }, epoch);
                    resolve();
                };
            });
        });
        return { calls, release: (grants: DeviceGrants) => release(grants) };
    }

    const output = (data: string) => ({ deviceId: DEVICE, sessionId: 't1', data });

    it('la sortie d’un terminal attend le recalcul, puis arrive dans l’ordre', async () => {
        const hub = onlineHub();
        const browser = watching(hub, TERM_HOLDER);
        const refresh = refresherOf(hub, browser);
        hub.requestTermOpen(browser.socket, DEVICE, { sessionId: 't1', cols: 80, rows: 24 });

        invalidateAccess();
        hub.publishTermOutput(output('YQ=='));
        hub.publishMetric(DEVICE, {} as never);
        hub.publishTermOutput(output('Yg=='));
        assert.deepEqual(browser.got, []);
        assert.deepEqual(refresh.calls, [WORKSPACE]);

        refresh.release(TERM_HOLDER);
        await settle();
        hub.publishTermOutput(output('Yw=='));
        hub.publishMetric(DEVICE, {} as never);

        assert.deepEqual(
            browser.data.map((d) => (d as { data?: string }).data),
            ['YQ==', 'Yg==', 'Yw==', undefined]
        );
        assert.deepEqual(browser.got.at(-1), 'metrics.push');
        assert.deepEqual(refresh.calls, [WORKSPACE]);
    });

    it('un recalcul qui retire le droit jette ce qui attendait', async () => {
        const hub = onlineHub();
        const browser = watching(hub, TERM_HOLDER);
        const refresh = refresherOf(hub, browser);
        hub.requestTermOpen(browser.socket, DEVICE, { sessionId: 't1', cols: 80, rows: 24 });

        invalidateAccess();
        hub.publishTermOutput(output('YQ=='));
        refresh.release(held());
        await settle();
        hub.publishTermOutput(output('Yg=='));

        assert.deepEqual(browser.got, []);
    });

    it('sans recalcul possible, rien ne part', () => {
        const hub = onlineHub();
        const browser = watching(hub, TERM_HOLDER);
        hub.requestTermOpen(browser.socket, DEVICE, { sessionId: 't1', cols: 80, rows: 24 });

        invalidateAccess();
        hub.publishTermOutput(output('YQ=='));

        assert.deepEqual(browser.got, []);
    });

    it('une machine qui se déconnecte clôt ses terminaux chez qui les a ouverts', () => {
        const hub = new MonitorHub();
        const agent = fakeAgent();
        hub.agentOnline(DEVICE, agent.socket);
        const owner = watching(hub, TERM_HOLDER);
        const other = watching(hub, TERM_HOLDER);
        hub.requestTermOpen(owner.socket, DEVICE, { sessionId: 't1', cols: 80, rows: 24 });

        hub.agentOffline(DEVICE, agent.socket);

        assert.deepEqual(
            owner.got.filter((command) => command === 'device.termExit'),
            ['device.termExit']
        );
        assert.deepEqual(
            other.got.filter((command) => command === 'device.termExit'),
            []
        );
        assert.equal(hub.ownsTermSession(owner.socket, 't1'), false);
    });
});

describe('MonitorHub : l’avancement d’un partage CloudSync', () => {
    const SHARE = 5;
    const progress = { shareId: SHARE } as never;

    function syncing(hub: MonitorHub, cloudSync: boolean): ReturnType<typeof fakeBrowser> {
        const browser = fakeBrowser();
        hub.subscribeSync(browser.socket, WORKSPACE, [SHARE]);
        hub.rememberGrants(browser.socket, WORKSPACE, { devices: held(), cloudSync }, accessEpochNow());
        return browser;
    }

    it('ne va qu’à qui lit encore CloudSync dans l’espace de son abonnement', () => {
        const hub = new MonitorHub();
        const reader = syncing(hub, true);
        const former = syncing(hub, false);

        hub.publishSyncProgress(progress);
        hub.publishSyncState(progress);

        assert.deepEqual(reader.got, ['cloudSync.progress', 'cloudSync.state']);
        assert.deepEqual(former.got, []);
    });

    it('un instantané périmé saute la trame et se fait recalculer', async () => {
        const hub = new MonitorHub();
        const browser = syncing(hub, true);
        let calls = 0;
        hub.setRefresher(browser.socket, async (workspaceId) => {
            calls++;
            hub.rememberGrants(browser.socket, workspaceId, { devices: held(), cloudSync: true }, accessEpochNow());
        });

        invalidateAccess();
        hub.publishSyncProgress(progress);
        assert.deepEqual(browser.got, []);
        await settle();
        hub.publishSyncProgress(progress);

        assert.equal(calls, 1);
        assert.deepEqual(browser.got, ['cloudSync.progress']);
    });
});
