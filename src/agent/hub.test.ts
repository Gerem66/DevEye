import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WebSocket } from '@fastify/websocket';

import { MonitorHub } from './hub';

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
