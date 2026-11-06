import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SceneElement } from '../../contracts/domain';
import { Sessions, type SaveResult, type SceneStore, type StoredScene } from './sessions';

const el = (id: string, over: Partial<SceneElement> = {}): SceneElement => ({
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 10,
    isDeleted: false,
    index: 'a0',
    updated: 0,
    ...over
});

function harness(initial: StoredScene | null = { workspaceId: 1, version: 1, elements: [] }) {
    let clock = 1_000_000;
    let stored = initial;
    let loads = 0;
    let overQuota = false;
    const saves: { baseVersion: number; elements: readonly SceneElement[] }[] = [];
    const frames: { workspaceId: number; userIds: readonly number[]; event: string; payload: unknown }[] = [];
    const changed: number[] = [];
    const store: SceneStore = {
        async load() {
            loads++;
            await Promise.resolve();
            return stored && { ...stored, elements: [...stored.elements] };
        },
        async save({ baseVersion, elements }): Promise<SaveResult> {
            saves.push({ baseVersion, elements });
            if (stored === null) return { ok: false, reason: 'gone' };
            if (stored.version !== baseVersion) return { ok: false, reason: 'stale' };
            stored = { ...stored, version: baseVersion + 1, elements: [...elements] };
            return { ok: true, version: baseVersion + 1 };
        },
        ownerOverQuota: () => Promise.resolve(overQuota)
    };
    const sessions = new Sessions({
        store,
        publishTo: (workspaceId, userIds, event, payload) => frames.push({ workspaceId, userIds, event, payload }),
        changed: (ws) => changed.push(ws),
        logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
        now: () => clock
    });
    const join = (clientId: string, userId: number, workspaceId = 1, canWrite = true) =>
        sessions.join({
            boardId: 7,
            home: 1,
            clientId,
            connId: null,
            userId,
            workspaceId,
            name: `u${userId}`,
            color: 'blue',
            canWrite
        });
    return {
        sessions,
        join,
        frames,
        saves,
        changed,
        get loads() {
            return loads;
        },
        get stored() {
            return stored;
        },
        setStored(next: StoredScene) {
            stored = next;
        },
        setOverQuota(v: boolean) {
            overQuota = v;
        },
        advance(ms: number) {
            clock += ms;
        }
    };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('Sessions', () => {
    it('deux entrées simultanées ne lisent la base qu’une fois', async () => {
        const h = harness();
        await Promise.all([h.join(A, 1), h.join(B, 2)]);
        assert.equal(h.loads, 1);
        assert.equal(h.sessions.participants(7), 2);
    });

    it('numérote ce qui est accepté et le rediffuse à chaque salle, auteur compris', async () => {
        const h = harness();
        await h.join(A, 1, 1);
        await h.join(B, 2, 5);
        h.frames.length = 0;
        const res = h.sessions.push(7, A, 1, [el('x')]);
        assert.deepEqual(res, { seq: 1, accepted: 1, refused: null });
        const elementsFrames = h.frames.filter((f) => f.event === 'whiteboard.elements');
        assert.deepEqual(
            elementsFrames.map((f) => [f.workspaceId, f.userIds]),
            [
                [1, [1]],
                [5, [2]]
            ]
        );
        const again = h.sessions.push(7, B, 2, [el('x')]);
        assert.deepEqual(again, { seq: 1, accepted: 0, refused: null });
    });

    it('relaie une sélection sans écrire, et refuse un participant inconnu', async () => {
        const h = harness();
        await h.join(A, 1);
        await h.join(B, 2);
        h.frames.length = 0;
        h.sessions.presence(7, A, 1, { selectedIds: ['x'], laser: false });
        assert.equal(h.frames.filter((f) => f.event === 'whiteboard.presence').length, 1);
        assert.throws(() => h.sessions.push(7, A, 99, [el('x')]), { code: 'conflict' });
    });

    it('écrit au départ du dernier, après un silence, et à l’arrêt', async () => {
        const h = harness();
        await h.join(A, 1);
        h.sessions.push(7, A, 1, [el('x')]);
        await h.sessions.tick();
        assert.equal(h.saves.length, 0);
        h.advance(2_500);
        await h.sessions.tick();
        assert.equal(h.saves.length, 1);
        assert.equal(h.stored?.version, 2);

        h.sessions.push(7, A, 1, [el('y')]);
        await h.sessions.leave(7, A, 1);
        assert.equal(h.saves.length, 2);
        assert.deepEqual(
            h.stored?.elements.map((e) => e.id),
            ['x', 'y']
        );
        // Une fois par minute au plus, et toujours quand la séance se vide.
        assert.deepEqual(h.changed, [1, 1]);
    });

    it('une version écrite ailleurs se fusionne puis s’écrit par-dessus', async () => {
        const h = harness();
        await h.join(A, 1);
        h.sessions.push(7, A, 1, [el('mine')]);
        h.setStored({ workspaceId: 1, version: 5, elements: [el('theirs')] });
        h.advance(3_000);
        await h.sessions.tick();
        h.advance(3_000);
        await h.sessions.tick();
        assert.equal(h.stored?.version, 6);
        assert.deepEqual(h.stored?.elements.map((e) => e.id).sort(), ['mine', 'theirs']);
    });

    it('au-delà de l’offre, seules les poussées qui n’agrandissent pas passent', async () => {
        const h = harness({ workspaceId: 1, version: 1, elements: [el('x', { width: 100 })] });
        h.setOverQuota(true);
        const joined = await h.join(A, 1);
        assert.equal(joined.overQuota, true);
        assert.equal(h.sessions.push(7, A, 1, [el('big', { text: 'x'.repeat(200) })]).refused, 'quota');
        assert.equal(h.sessions.push(7, A, 1, [el('x', { version: 2, isDeleted: true })]).accepted, 1);
    });

    it('stop écrit ce qui reste', async () => {
        const h = harness();
        await h.join(A, 1);
        h.sessions.push(7, A, 1, [el('x')]);
        await h.sessions.stop();
        assert.equal(h.stored?.version, 2);
    });

    it('un tableau supprimé ferme la séance et le dit aux participants', async () => {
        const h = harness();
        await h.join(A, 1);
        await h.sessions.close(7, 'removed', { discard: true });
        assert.equal(h.sessions.participants(7), 0);
        assert.equal(h.frames.at(-1)?.event, 'whiteboard.closed');
        assert.equal(h.saves.length, 0);
    });
});
