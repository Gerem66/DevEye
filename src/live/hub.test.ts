import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { WebSocket } from '@fastify/websocket';
import { LIVE_CURSORS_EVENT, LIVE_PEERS_EVENT, type LiveCursor } from '@deveye/types';

import { LiveHub, type CursorPass } from './hub';

const AT: LiveCursor = { x: 120, y: -40, kind: 'default' };
const BOARD = ['view:whiteboard', 'l1:7'];
const CHANNEL = 'whiteboard:7';

function socket() {
    const frames: { command: string; data: Record<string, unknown> }[] = [];
    const fake = {
        bufferedAmount: 0,
        on: () => undefined,
        send: (raw: string) => {
            const msg = JSON.parse(raw) as { command: string; payload: { data: Record<string, unknown> } };
            frames.push({ command: msg.command, data: msg.payload.data });
        },
        close: () => undefined,
        ping: () => undefined,
        terminate: () => undefined
    };
    return { ws: fake as unknown as WebSocket, frames };
}

function harness(t: TestContext) {
    // Loin de zéro : le plancher de cadence compte depuis la dernière trame, `0` au départ.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const hub = new LiveHub();
    const join = (userId: number, workspaceId: number) => {
        const s = socket();
        const live = hub.register(s.ws, userId, `session-${userId}`);
        live.here(workspaceId, BOARD, 'blue');
        return { ...s, live };
    };
    const pass = (workspaceId: number, name: string): CursorPass => ({
        channel: CHANNEL,
        feature: 'whiteboard',
        workspaceId,
        name
    });
    const tick = () => t.mock.timers.tick(100);
    const cursorsOf = (frames: { command: string; data: Record<string, unknown> }[]) =>
        frames.filter((f) => f.command === LIVE_CURSORS_EVENT).at(-1)?.data;
    return { hub, join, pass, tick, cursorsOf };
}

describe('LiveHub : curseurs dans un canal', () => {
    it('relie deux espaces entrés dans le même canal, et eux seuls', (t) => {
        const h = harness(t);
        const alice = h.join(1, 10);
        const bob = h.join(2, 20);
        const carol = h.join(3, 10);
        const aliceConn = alice.live.grantCursors(h.pass(10, 'alice'), 'red');
        bob.live.grantCursors(h.pass(20, 'bob'), 'green');
        h.tick();

        h.hub.cursor(alice.ws, { cursor: AT, channel: CHANNEL });
        h.hub.cursor(bob.ws, { cursor: null, channel: CHANNEL });
        h.hub.cursor(carol.ws, { cursor: AT, channel: null });
        h.tick();

        assert.deepEqual(h.cursorsOf(bob.frames), {
            workspaceId: 20,
            channel: CHANNEL,
            cursors: [{ connId: aliceConn, userId: 1, color: 'blue', name: 'alice', cursor: AT }]
        });
        // Carol est au même chemin que Alice, mais pas sur sa surface.
        assert.equal(h.cursorsOf(carol.frames), undefined);
        const peers = alice.frames.filter((f) => f.command === LIVE_PEERS_EVENT).at(-1)?.data.peers as {
            userId: number;
            cursor: LiveCursor | null;
        }[];
        assert.equal(peers.find((p) => p.userId === 1)?.cursor, null);
    });

    it('ignore une trame qui nomme un canal sans laissez-passer', (t) => {
        const h = harness(t);
        const alice = h.join(1, 10);
        const mallory = h.join(4, 10);
        alice.live.grantCursors(h.pass(10, 'alice'), 'red');
        h.hub.cursor(alice.ws, { cursor: null, channel: CHANNEL });
        h.tick();

        h.hub.cursor(mallory.ws, { cursor: AT, channel: CHANNEL });
        h.tick();

        assert.equal(h.cursorsOf(alice.frames), undefined);
    });

    it('rend la popup au curseur qui quitte son canal', (t) => {
        const h = harness(t);
        const alice = h.join(1, 10);
        const bob = h.join(2, 20);
        alice.live.grantCursors(h.pass(10, 'alice'), 'red');
        bob.live.grantCursors(h.pass(20, 'bob'), 'green');
        h.hub.cursor(alice.ws, { cursor: AT, channel: CHANNEL });
        h.hub.cursor(bob.ws, { cursor: null, channel: CHANNEL });
        h.tick();
        assert.equal((h.cursorsOf(bob.frames)?.cursors as unknown[]).length, 1);

        alice.live.revokeCursors(CHANNEL);
        h.tick();
        assert.deepEqual(h.cursorsOf(bob.frames)?.cursors, []);
        // Plus de laissez-passer : son curseur n'y rentre plus.
        h.hub.cursor(alice.ws, { cursor: AT, channel: CHANNEL });
        h.tick();
        assert.deepEqual(h.cursorsOf(bob.frames)?.cursors, []);
    });

    it('montre aux pairs du canal le pseudo changé, sans attendre un mouvement', (t) => {
        const h = harness(t);
        const alice = h.join(1, 10);
        const bob = h.join(2, 20);
        alice.live.grantCursors(h.pass(10, 'alice'), 'red');
        bob.live.grantCursors(h.pass(20, 'bob'), 'green');
        h.hub.cursor(alice.ws, { cursor: AT, channel: CHANNEL });
        h.hub.cursor(bob.ws, { cursor: null, channel: CHANNEL });
        h.tick();

        alice.live.nameChanged('alicia');
        h.tick();

        assert.deepEqual(
            (h.cursorsOf(bob.frames)?.cursors as { name: string }[]).map((c) => c.name),
            ['alicia']
        );
    });

    it('retire le canal à qui quitte l’espace qui l’a ouvert', (t) => {
        const h = harness(t);
        const alice = h.join(1, 10);
        const bob = h.join(2, 20);
        alice.live.grantCursors(h.pass(10, 'alice'), 'red');
        bob.live.grantCursors(h.pass(20, 'bob'), 'green');
        h.hub.cursor(alice.ws, { cursor: null, channel: CHANNEL });
        h.tick();

        bob.live.here(30, [], 'green');
        h.hub.cursor(bob.ws, { cursor: AT, channel: CHANNEL });
        h.tick();

        assert.equal(h.cursorsOf(alice.frames), undefined);
    });
});
