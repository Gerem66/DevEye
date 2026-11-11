import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { WebSocket } from '@fastify/websocket';
import {
    err,
    ok,
    REQUEST_PROGRESS_EVENT,
    TASK_REMOVED_EVENT,
    TASK_UPDATE_EVENT,
    type ServerMessage,
    type TaskSnapshot
} from '@deveye/types';

import { TaskRegistry, type TaskOpening } from './tasks';

const ID = '0b6f5e0a-2a57-4a55-9a56-0d7c1d2a3b4c';
const OTHER = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

interface Push {
    userId: number;
    command: string;
    data: unknown;
    except?: WebSocket | null;
    must?: boolean;
}

function socket() {
    const frames: ServerMessage[] = [];
    const fake = { readyState: 1, send: (raw: string) => void frames.push(JSON.parse(raw) as ServerMessage) };
    return {
        ws: fake as unknown as WebSocket,
        frames,
        close: () => {
            fake.readyState = 3;
        }
    };
}

function harness(t: TestContext) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    const pushes: Push[] = [];
    const registry = new TaskRegistry();
    registry.init({
        // L'instantané est copié : le registre le fait évoluer en place.
        live: {
            toUser: (userId, command, data, options = {}) =>
                void pushes.push({ userId, command, data: structuredClone(data), ...options })
        }
    });
    t.after(() => registry.close());
    const page = socket();
    const opening = (over: Partial<TaskOpening> = {}): TaskOpening => ({
        userId: 1,
        sessionId: 'session-a',
        socket: page.ws,
        requestId: 'req-1',
        workspaceId: 10,
        tag: { id: ID, title: 'Suppression du point de restauration' },
        guarded: false,
        ...over
    });
    const updates = () => pushes.filter((p) => p.command === TASK_UPDATE_EVENT);
    const removals = () => pushes.filter((p) => p.command === TASK_REMOVED_EVENT);
    const listed = () => registry.roster(1).list.map((task) => task.id);
    return { registry, page, pushes, opening, updates, removals, listed, tick: (ms: number) => t.mock.timers.tick(ms) };
}

const done = (requestId = 'req-1'): ServerMessage => ({ requestId, command: 'x.run', payload: ok({ fine: true }) });
const refused = (code: Parameters<typeof err>[0], requestId = 'req-1'): ServerMessage => ({
    requestId,
    command: 'x.run',
    payload: err(code, 'Refusé', { input: 'secret' })
});

describe('TaskRegistry : annonce', () => {
    it('attend 300 ms, puis prévient tout le compte sauf la socket qui attend la réponse', (t) => {
        const h = harness(t);
        h.registry.open(h.opening());
        h.tick(299);
        assert.equal(h.updates().length, 0);
        assert.deepEqual(h.listed(), []);

        h.tick(1);
        assert.equal(h.updates().length, 1);
        const push = h.updates()[0]!;
        assert.equal(push.userId, 1);
        assert.equal(push.except, h.page.ws);
        assert.equal((push.data as TaskSnapshot).state, 'running');
        assert.deepEqual(h.listed(), [ID]);
    });

    it('ne montre pas le résultat d’une opération que sa page retire en le recevant', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(2000);
        task.settle(done());
        h.tick(20);
        h.registry.dismiss(1, [ID]);
        h.tick(1000);
        assert.deepEqual(
            h.pushes.map((p) => [p.command, (p.data as { state?: string }).state]),
            [
                ['task.update', 'running'],
                ['task.removed', undefined]
            ]
        );
    });

    it('ne dit rien d’une commande éclair que sa page retire aussitôt', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(50);
        task.settle(done());
        assert.deepEqual(h.registry.dismiss(1, [ID]), [ID]);
        h.tick(1000);
        assert.equal(h.pushes.length, 0);
        assert.deepEqual(h.listed(), []);
    });

    it('annonce fini un résultat éclair qui reste', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening({ tag: { id: ID, title: 'Vérification', done: 'Tout est intact.' } }))!;
        h.tick(50);
        task.settle(done());
        assert.equal(h.updates().length, 0);
        h.tick(300);
        assert.equal(h.updates().length, 1);
        const push = h.updates()[0]!;
        assert.equal(push.must, true);
        assert.deepEqual(
            { state: (push.data as TaskSnapshot).state, done: (push.data as TaskSnapshot).done },
            { state: 'done', done: 'Tout est intact.' }
        );
    });

    it('régule l’avancement, vers la requête de la page et vers les autres onglets', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(300);
        task.report({ done: 1, total: 4 });
        task.report({ done: 2, total: 4 });
        const progress = () => h.page.frames.filter((f) => f.command === REQUEST_PROGRESS_EVENT);
        assert.equal(progress().length, 1);
        h.tick(250);
        assert.equal(progress().length, 2);
        assert.deepEqual(progress()[1]!.payload, { ok: true, data: { requestId: 'req-1', done: 2, total: 4 } });
        // L'annonce, puis une trame par avancement publié.
        assert.equal(h.updates().length, 3);
        assert.equal((h.updates()[2]!.data as TaskSnapshot).progress?.done, 2);
    });
});

describe('TaskRegistry : réponse', () => {
    it('remet la réponse à la socket qui attend, et la garde encore une minute', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(1000);
        task.settle(done());
        assert.deepEqual(h.page.frames.at(-1), done());
        // Le temps, pour la page servie, de retirer une opération restée devant elle.
        assert.equal((h.updates().at(-1)!.data as TaskSnapshot).state, 'running');
        h.tick(300);
        assert.equal((h.updates().at(-1)!.data as TaskSnapshot).state, 'done');

        const back = socket();
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), []);
        assert.deepEqual(back.frames, [done()]);

        h.tick(61_000);
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
        // L'instantané, lui, reste.
        assert.deepEqual(h.listed(), [ID]);
    });

    it('retient dix minutes la réponse d’une socket partie, pour qui présente la requête depuis la même session', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.page.close();
        h.registry.dropSocket(1, h.page.ws);
        h.tick(5000);
        task.settle(done());
        // Plus de socket à écarter : le compte entier apprend la fin.
        assert.equal(h.updates().at(-1)!.except, null);

        const back = socket();
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'guess' }]), [ID]);
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-b', [{ id: ID, requestId: 'req-1' }]), [ID]);
        assert.deepEqual(h.registry.attach(back.ws, 2, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
        assert.equal(back.frames.length, 0);

        h.tick(9 * 60_000);
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), []);
        assert.deepEqual(back.frames, [done()]);
    });

    it('oublie la réponse non réclamée au bout de dix minutes', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.registry.dropSocket(1, h.page.ws);
        task.settle(done());
        h.tick(11 * 60_000);
        assert.deepEqual(h.registry.attach(socket().ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
    });

    it('rattache une opération en cours : avancement et réponse vont à la socket revenue', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(300);
        h.page.close();
        h.registry.dropSocket(1, h.page.ws);
        const back = socket();
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), []);

        task.report({ step: 'Lecture' });
        assert.equal(back.frames.at(-1)?.command, REQUEST_PROGRESS_EVENT);
        assert.equal(h.updates().at(-1)!.except, back.ws);
        task.settle(done());
        assert.deepEqual(back.frames.at(-1), done());
        assert.equal(
            h.page.frames.some((f) => f.requestId === 'req-1'),
            false
        );
    });

    it('dit l’échec sans ses détails, qui peuvent citer l’entrée', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening({ tag: { id: ID, title: 'Restauration', failed: 'Échec.' } }))!;
        h.tick(300);
        task.settle(refused('conflict'));
        h.tick(300);
        const last = h.updates().at(-1)!.data as TaskSnapshot;
        assert.deepEqual(last.error, { code: 'conflict', message: 'Refusé' });
        assert.equal(last.state, 'failed');
        // La page qui attend reçoit, elle, la réponse entière.
        assert.deepEqual(h.page.frames.at(-1), refused('conflict'));
    });

    it('efface l’opération d’un refus qui se rejoue', (t) => {
        const h = harness(t);
        const quick = h.registry.open(h.opening())!;
        quick.settle(refused('locked'));
        h.tick(1000);
        assert.equal(h.pushes.length, 0);
        assert.deepEqual(h.page.frames, [refused('locked')]);

        const slow = h.registry.open(h.opening({ requestId: 'req-2' }))!;
        h.tick(300);
        slow.settle(refused('stepup_required', 'req-2'));
        assert.deepEqual(h.removals().at(-1)?.data, { ids: [ID] });
        assert.deepEqual(h.listed(), []);
    });

    it('ne retient pas une réponse trop lourde, et tient le budget du compte', (t) => {
        const h = harness(t);
        const heavy = h.registry.open(h.opening())!;
        h.registry.dropSocket(1, h.page.ws);
        heavy.settle({ requestId: 'req-1', command: 'x.run', payload: ok({ blob: 'x'.repeat(300 * 1024) }) });
        assert.deepEqual(h.registry.attach(socket().ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
        assert.deepEqual(h.listed(), []);
        h.tick(300);
        assert.deepEqual(h.listed(), [ID]);

        // Cinq réponses de 250 Kio : la première cède sa place à la cinquième.
        const ids = [0, 1, 2, 3, 4].map((n) => `${OTHER.slice(0, -1)}${n}`);
        for (const [n, id] of ids.entries()) {
            const gone = socket();
            const task = h.registry.open(
                h.opening({ requestId: `big-${n}`, tag: { id, title: 'Export' }, socket: gone.ws })
            )!;
            h.registry.dropSocket(1, gone.ws);
            h.tick(10);
            task.settle({ requestId: `big-${n}`, command: 'x.run', payload: ok({ blob: 'x'.repeat(250 * 1024) }) });
        }
        const claim = (n: number) =>
            h.registry.attach(socket().ws, 1, 'session-a', [{ id: ids[n]!, requestId: `big-${n}` }]);
        assert.deepEqual(claim(0), [ids[0]]);
        assert.deepEqual(claim(4), []);
        assert.deepEqual(claim(1), []);
    });
});

describe('TaskRegistry : retrait', () => {
    it('délaisse une opération en cours : elle sort de la zone, sa réponse part encore', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.tick(300);
        assert.deepEqual(h.registry.dismiss(1, [ID, ID, OTHER]), [ID]);
        assert.deepEqual(h.removals().at(-1)?.data, { ids: [ID] });
        assert.equal(h.removals().at(-1)?.must, true);
        assert.deepEqual(h.listed(), []);

        const before = h.pushes.length;
        task.report({ step: 'Suite' });
        task.settle(done());
        assert.equal(h.pushes.length, before);
        assert.deepEqual(h.page.frames.at(-1), done());
        assert.deepEqual(h.registry.attach(socket().ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
    });

    it('retire un résultat pour tout le compte', (t) => {
        const h = harness(t);
        h.registry.open(h.opening())!.settle(done());
        h.tick(300);
        assert.deepEqual(h.registry.dismiss(1, [ID]), [ID]);
        assert.deepEqual(h.removals().at(-1)?.data, { ids: [ID] });
        assert.deepEqual(h.registry.dismiss(1, [ID]), []);
    });

    it('oublie un résultat au bout de vingt-quatre heures', (t) => {
        const h = harness(t);
        h.registry.open(h.opening())!.settle(done());
        h.tick(23 * 3_600_000);
        assert.deepEqual(h.listed(), [ID]);
        h.tick(3_600_000 + 60_000);
        assert.deepEqual(h.listed(), []);
        assert.deepEqual(h.removals().at(-1)?.data, { ids: [ID] });
    });
});

describe('TaskRegistry : audience et plafonds', () => {
    it('ne montre ni ne retient rien d’un espace que le mot de passe garde, mais répond à la socket revenue', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening({ guarded: true }))!;
        h.tick(1000);
        task.report({ step: 'Lecture du coffre' });
        assert.equal(h.pushes.length, 0);
        assert.deepEqual(h.listed(), []);
        assert.deepEqual(h.registry.dismiss(1, [ID]), []);

        h.page.close();
        h.registry.dropSocket(1, h.page.ws);
        const back = socket();
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), []);
        task.settle(done());
        task.settle(refused('internal'));
        assert.deepEqual(back.frames, [done()]);

        // Finie : plus de trace, pas même pour la page qui l'a lancée.
        assert.deepEqual(h.registry.attach(back.ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
        h.tick(1000);
        assert.equal(h.pushes.length, 0);
        assert.deepEqual(h.listed(), []);
    });

    it('perd la réponse d’un espace gardé quand sa socket n’est pas revenue à temps', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening({ guarded: true }))!;
        h.registry.dropSocket(1, h.page.ws);
        task.settle(done());
        assert.deepEqual(h.registry.attach(socket().ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
    });

    it('retire à une session révoquée ses réponses retenues, pas l’opération du compte', (t) => {
        const h = harness(t);
        const task = h.registry.open(h.opening())!;
        h.registry.dropSocket(1, h.page.ws);
        task.settle(done());
        h.tick(300);
        h.registry.revoke({ userId: 1, keepSessionId: 'session-b' });
        assert.deepEqual(h.registry.attach(socket().ws, 1, 'session-a', [{ id: ID, requestId: 'req-1' }]), [ID]);
        assert.deepEqual(h.listed(), [ID]);
    });

    it('ne reprend un id qu’une fois l’opération finie, depuis la session qui l’a lancée', (t) => {
        const h = harness(t);
        const first = h.registry.open(h.opening())!;
        assert.equal(h.registry.open(h.opening({ requestId: 'req-2' })), null);
        first.settle(done());
        h.tick(300);
        assert.equal(h.registry.open(h.opening({ requestId: 'req-2', sessionId: 'session-b' })), null);

        assert.notEqual(h.registry.open(h.opening({ requestId: 'req-2' })), null);
        // L'ancien résultat quitte les onglets avant que la reprise s'annonce.
        assert.deepEqual(h.removals().at(-1)?.data, { ids: [ID] });
        h.tick(300);
        assert.equal((h.updates().at(-1)!.data as TaskSnapshot).state, 'running');
    });

    it('à cinquante opérations, la plus ancienne finie cède ; sans finie, la commande n’est pas suivie', (t) => {
        const h = harness(t);
        const id = (n: number) => `task-${String(n).padStart(4, '0')}`;
        const handles = Array.from({ length: 50 }, (_, n) => {
            h.tick(1);
            return h.registry.open(h.opening({ requestId: `r-${n}`, tag: { id: id(n), title: 'Lot' } }))!;
        });
        assert.equal(h.registry.open(h.opening({ requestId: 'r-50', tag: { id: id(50), title: 'Lot' } })), null);

        handles[7]!.settle(done('r-7'));
        h.tick(10);
        handles[3]!.settle(done('r-3'));
        assert.notEqual(h.registry.open(h.opening({ requestId: 'r-50', tag: { id: id(50), title: 'Lot' } })), null);
        h.tick(300);
        assert.equal(h.listed().includes(id(7)), false);
        assert.equal(h.listed().includes(id(3)), true);
    });
});
