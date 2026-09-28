import { IDLE_CLOSE_CODE, seatCapsSchema, type Seat, type SeatCaps } from '@deveye/types';
import type { AccountPlan } from '@deveye/types/sdk';

import type { Database } from '@/db';

/** Un compte qui ne relance plus sa demande a quitté la file. */
const WAITER_TTL_MS = 60_000;
/** Un rechargement de page, un aller-retour chez Stripe : la place attend. */
const GRACE_MS = 2 * 60_000;
/** Après un démarrage, ceux qui étaient là reviennent avant les autres. */
const WARMUP_MS = 2 * 60_000;
/** Sans geste depuis, une place peut aller à qui attend. */
export const IDLE_MS = 20 * 60_000;
const SWEEP_MS = 60_000;

const SETTING = 'seats';
const UNLIMITED: SeatCaps = { free: null, paid: null };
const SEATS: readonly Seat[] = ['free', 'paid'];

/** Ce que l'admission lit et ferme des sockets de navigateur (`live/hub.ts`). */
export interface AdmissionLive {
    holdsSocket(userId: number): boolean;
    /** Les comptes assis dans cette catégorie, et leur dernier geste (le plus récent de leurs onglets). */
    seated(seat: Seat): ReadonlyMap<number, number>;
    closeUser(userId: number, code: number, reason: string): void;
    onLastSocketGone(fn: (userId: number, seat: Seat | null) => void): void;
}

interface Deps {
    db: Pick<Database, 'instanceSettings' | 'users'>;
    live: AdmissionLive;
    logger: { warn(obj: object, msg: string): void };
    /** L'origine de ce serveur : les places se rangent par serveur, comme ses sockets. */
    origin: string;
    /** `null` : aucun module ne tient les offres. */
    planOf(userId: number): Promise<AccountPlan | null>;
    now?: () => number;
}

export type Verdict = { ok: true } | { ok: false; position: number };

export interface AdmissionStats {
    present: Record<Seat, number>;
    waiting: Record<Seat, number>;
}

/**
 * Les places simultanées : combien de comptes gratuits et d'abonnés tiennent une
 * socket en même temps, et la file de ceux qui attendent. Tout est en mémoire,
 * le processus étant seul. Baisser un plafond ne ferme jamais un compte actif :
 * seule une place inactive depuis {@link IDLE_MS} va à qui attend.
 */
export class AdmissionStore {
    private deps: Deps | null = null;
    private caps: SeatCaps = UNLIMITED;
    private stored: { updated: number; updatedBy: { id: number; username: string } | null } | null = null;
    /** L'ordre d'insertion est celui de la file. */
    private readonly waiting = new Map<number, { seat: Seat; seenAt: number }>();
    private readonly grace = new Map<number, { seat: Seat; until: number }>();
    /** Fermés pour inactivité : leur place part aussitôt, sans délai de grâce. */
    private readonly released = new Set<number>();
    private bootedAt = 0;
    private timer: ReturnType<typeof setInterval> | null = null;

    async init(deps: Deps): Promise<void> {
        this.deps = deps;
        this.bootedAt = this.now();
        await this.reload();
        deps.live.onLastSocketGone((userId, seat) => {
            if (this.released.delete(userId) || seat === null) return;
            this.grace.set(userId, { seat, until: this.now() + GRACE_MS });
        });
        this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
        this.timer.unref();
    }

    close(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** L'administrateur et les comptes d'un essai de bout en bout ne prennent aucune place. */
    async seatOf(userId: number): Promise<Seat | null> {
        const { db, planOf } = this.need();
        const user = await db.users.findById(userId);
        if (!user || user.role === 'admin' || user.e2e_run !== null) return null;
        return (await planOf(userId))?.priority ? 'paid' : 'free';
    }

    /** Synchrone : rien ne s'intercale entre la décision et l'inscription de la socket. */
    admit(userId: number, seat: Seat | null): Verdict {
        if (seat === null) return { ok: true };
        const { live } = this.need();
        const now = this.now();
        if (live.holdsSocket(userId)) return { ok: true };
        const held = this.grace.get(userId);
        if (held && held.until > now) {
            this.grace.delete(userId);
            return { ok: true };
        }
        const cap = this.caps[seat];
        if (cap === null || now - this.bootedAt < WARMUP_MS) {
            this.waiting.delete(userId);
            return { ok: true };
        }
        this.prune(now);
        const entry = this.waiting.get(userId);
        if (entry) entry.seenAt = now;
        else this.waiting.set(userId, { seat, seenAt: now });
        const position = this.positionOf(userId, seat);
        if (position <= cap - this.used(seat, now)) {
            this.waiting.delete(userId);
            return { ok: true };
        }
        return { ok: false, position };
    }

    stats(): AdmissionStats {
        const now = this.now();
        this.prune(now);
        const count = (seat: Seat): number => [...this.waiting.values()].filter((w) => w.seat === seat).length;
        return {
            present: { free: this.need().live.seated('free').size, paid: this.need().live.seated('paid').size },
            waiting: { free: count('free'), paid: count('paid') }
        };
    }

    settings(): SeatCaps & { updated: number | null; updatedBy: { id: number; username: string } | null } {
        return { ...this.caps, updated: this.stored?.updated ?? null, updatedBy: this.stored?.updatedBy ?? null };
    }

    async setCaps(caps: SeatCaps, by: number): Promise<void> {
        const { db, origin } = this.need();
        await db.instanceSettings.put(SETTING, origin, JSON.stringify(caps), by);
        await this.reload();
    }

    /** Relit le réglage, retire ce qui a expiré, et libère les places inactives dont la file a besoin. */
    async sweep(): Promise<void> {
        const { live, logger } = this.need();
        try {
            await this.reload();
        } catch (err) {
            logger.warn({ err }, 'admission : relecture du réglage en échec');
        }
        const now = this.now();
        this.prune(now);
        for (const seat of SEATS) {
            const cap = this.caps[seat];
            if (cap === null) continue;
            const waiters = [...this.waiting.values()].filter((w) => w.seat === seat).length;
            const need = waiters - Math.max(0, cap - this.used(seat, now));
            if (need <= 0) continue;
            const idle = [...live.seated(seat)]
                .filter(([, activeAt]) => now - activeAt >= IDLE_MS)
                .sort(([, a], [, b]) => a - b)
                .slice(0, need);
            for (const [userId] of idle) {
                this.released.add(userId);
                live.closeUser(userId, IDLE_CLOSE_CODE, 'idle');
            }
        }
    }

    private async reload(): Promise<void> {
        const { db, origin } = this.need();
        const row = await db.instanceSettings.get(SETTING, origin);
        if (!row) {
            this.caps = UNLIMITED;
            this.stored = null;
            return;
        }
        let parsed: SeatCaps | null = null;
        try {
            const result = seatCapsSchema.safeParse(JSON.parse(row.value));
            if (result.success) parsed = result.data;
        } catch {
            // Illisible : sans limite, plutôt qu'un serveur fermé à tous.
        }
        this.caps = parsed ?? UNLIMITED;
        this.stored = { updated: row.updated, updatedBy: row.updatedBy };
    }

    private prune(now: number): void {
        for (const [userId, w] of this.waiting) if (now - w.seenAt > WAITER_TTL_MS) this.waiting.delete(userId);
        for (const [userId, g] of this.grace) if (g.until <= now) this.grace.delete(userId);
    }

    /** Les comptes assis, plus les places qu'un délai de grâce réserve. */
    private used(seat: Seat, now: number): number {
        const seated = this.need().live.seated(seat);
        let reserved = 0;
        for (const [userId, g] of this.grace) if (g.seat === seat && g.until > now && !seated.has(userId)) reserved++;
        return seated.size + reserved;
    }

    private positionOf(userId: number, seat: Seat): number {
        let position = 0;
        for (const [id, w] of this.waiting) {
            if (w.seat !== seat) continue;
            position++;
            if (id === userId) return position;
        }
        return position;
    }

    private now(): number {
        return this.deps?.now?.() ?? Date.now();
    }

    private need(): Deps {
        if (!this.deps) throw new Error('admission : init() manquant au boot');
        return this.deps;
    }
}

export const admission = new AdmissionStore();
