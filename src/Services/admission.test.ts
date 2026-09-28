import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IDLE_CLOSE_CODE, type Seat } from '@deveye/types';

import type { Database } from '@/db';
import { AdmissionStore, IDLE_MS, type AdmissionLive } from './admission';

const MIN = 60_000;

/** Les sockets en mémoire : un compte, sa catégorie et son dernier geste par onglet. */
function fakeLive() {
    const sockets: { userId: number; seat: Seat | null; activeAt: number }[] = [];
    const closed: { userId: number; code: number }[] = [];
    let gone: (userId: number, seat: Seat | null) => void = () => undefined;
    const drop = (userId: number): void => {
        const seat = sockets.find((s) => s.userId === userId)?.seat ?? null;
        for (let i = sockets.length - 1; i >= 0; i--) if (sockets[i].userId === userId) sockets.splice(i, 1);
        gone(userId, seat);
    };
    const live: AdmissionLive = {
        holdsSocket: (userId) => sockets.some((s) => s.userId === userId),
        seated: (seat) => {
            const out = new Map<number, number>();
            for (const s of sockets) {
                if (s.seat === seat) out.set(s.userId, Math.max(out.get(s.userId) ?? 0, s.activeAt));
            }
            return out;
        },
        closeUser: (userId, code) => {
            closed.push({ userId, code });
            drop(userId);
        },
        onLastSocketGone: (fn) => {
            gone = fn;
        }
    };
    return { live, sockets, closed, drop };
}

async function boot(caps: { free: number | null; paid: number | null } | null, opts: { warm?: boolean } = {}) {
    const clock = { now: 1_000_000_000 };
    const settings = new Map<string, string>();
    if (caps) settings.set('seats', JSON.stringify(caps));
    const db = {
        instanceSettings: {
            get: async (name: string, origin: string) => {
                const value = settings.get(name);
                return value === undefined ? null : { origin, value, updated: 1, updatedBy: null };
            },
            put: async (name: string, _origin: string, value: string) => void settings.set(name, value)
        },
        users: { findById: async () => null }
    } as unknown as Database;
    const fake = fakeLive();
    const store = new AdmissionStore();
    await store.init({
        db,
        live: fake.live,
        logger: { warn: () => undefined },
        origin: 'https://deveye.test',
        planOf: async () => null,
        now: () => clock.now
    });
    // Passé le temps de rattrapage du démarrage, sauf quand on le teste.
    if (!opts.warm) clock.now += 3 * MIN;
    const enter = (userId: number, seat: Seat = 'free') => {
        const verdict = store.admit(userId, seat);
        if (verdict.ok) fake.sockets.push({ userId, seat, activeAt: clock.now });
        return verdict;
    };
    return { store, clock, enter, ...fake };
}

describe('les places simultanées', () => {
    it('laissent tout entrer sans plafond', async () => {
        const t = await boot(null);
        for (let id = 1; id <= 50; id++) assert.deepEqual(t.enter(id), { ok: true });
    });

    it('font attendre au-delà du plafond, dans l’ordre d’arrivée, et font entrer la tête de file', async () => {
        const t = await boot({ free: 1, paid: null });
        assert.deepEqual(t.enter(1), { ok: true });
        assert.deepEqual(t.enter(2), { ok: false, position: 1 });
        assert.deepEqual(t.enter(3), { ok: false, position: 2 });
        // Le premier part : sa place attend le délai de grâce, la file relance.
        t.drop(1);
        for (let i = 0; i < 2; i++) {
            t.clock.now += 45_000;
            assert.deepEqual(t.enter(3), { ok: false, position: 2 });
            assert.deepEqual(t.enter(2), { ok: false, position: 1 });
        }
        // Le troisième relance avant le deuxième : il ne passe pas devant.
        t.clock.now += 45_000;
        assert.deepEqual(t.enter(3), { ok: false, position: 2 });
        assert.deepEqual(t.enter(2), { ok: true });
        assert.deepEqual(t.enter(3), { ok: false, position: 1 });
    });

    it('comptent les abonnés à part, et laissent entrer l’exempté sans le compter', async () => {
        const t = await boot({ free: 1, paid: 1 });
        assert.deepEqual(t.enter(1, 'free'), { ok: true });
        assert.deepEqual(t.enter(2, 'paid'), { ok: true });
        assert.deepEqual(t.store.admit(3, null), { ok: true });
        assert.deepEqual(t.enter(4, 'paid'), { ok: false, position: 1 });
    });

    it('laissent entrer un autre onglet du même compte', async () => {
        const t = await boot({ free: 1, paid: null });
        t.enter(1);
        assert.deepEqual(t.enter(1), { ok: true });
    });

    it('gardent la place d’un rechargement le temps du délai de grâce', async () => {
        const t = await boot({ free: 1, paid: null });
        t.enter(1);
        t.drop(1);
        assert.deepEqual(t.enter(2), { ok: false, position: 1 });
        assert.deepEqual(t.enter(1), { ok: true });
        t.drop(1);
        t.clock.now += 3 * MIN;
        assert.deepEqual(t.enter(2), { ok: true });
    });

    it('laissent revenir tout le monde juste après un démarrage', async () => {
        const t = await boot({ free: 1, paid: null }, { warm: true });
        assert.deepEqual(t.enter(1), { ok: true });
        assert.deepEqual(t.enter(2), { ok: true });
    });

    it('oublient celui qui ne relance plus sa demande', async () => {
        const t = await boot({ free: 1, paid: null });
        t.enter(1);
        t.enter(2);
        t.clock.now += 2 * MIN;
        assert.deepEqual(t.enter(3), { ok: false, position: 1 });
    });

    it('libèrent une place inactive seulement quand quelqu’un attend, sans délai de grâce', async () => {
        const t = await boot({ free: 1, paid: null });
        t.enter(1);
        t.clock.now += IDLE_MS + MIN;
        await t.store.sweep();
        assert.deepEqual(t.closed, []);

        assert.deepEqual(t.enter(2), { ok: false, position: 1 });
        await t.store.sweep();
        assert.deepEqual(t.closed, [{ userId: 1, code: IDLE_CLOSE_CODE }]);
        assert.deepEqual(t.enter(2), { ok: true });
        assert.deepEqual(t.enter(1), { ok: false, position: 1 });
    });

    it('ne ferment jamais un compte actif, même quand le plafond baisse', async () => {
        const t = await boot({ free: 3, paid: null });
        t.enter(1);
        t.enter(2);
        t.enter(3);
        await t.store.setCaps({ free: 1, paid: null }, 1);
        assert.deepEqual(t.enter(4), { ok: false, position: 1 });
        await t.store.sweep();
        assert.deepEqual(t.closed, []);
        assert.deepEqual(t.store.stats(), { present: { free: 3, paid: 0 }, waiting: { free: 1, paid: 0 } });
    });
});
