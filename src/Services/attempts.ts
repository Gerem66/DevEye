import { FeatureError } from '@/features/_define';

/**
 * Le verrouillage progressif de tout ce qui vérifie un secret : connexion,
 * code 2FA, déverrouillage du coffre, code de récupération. La limite de débit
 * HTTP ne voit qu'une poignée de main WebSocket, et compte par adresse : ici on
 * compte par cible (compte, identifiant, challenge), en mémoire du processus.
 * Un redémarrage remet les compteurs à zéro, ce qui est acceptable pour un
 * frein ; la trace, elle, est dans l'audit.
 */
export type AttemptScope = 'login' | 'signup' | 'twofa' | 'unlock' | 'recover' | 'password';

interface AttemptEntry {
    failures: number;
    lockedUntil: number;
    lastFailureAt: number;
}

const entries = new Map<string, AttemptEntry>();

/** Une entrée sans échec depuis ce délai est oubliée. */
const IDLE_MS = 3_600_000;
const SWEEP_MS = 60_000;

export class LockedOutError extends Error {
    constructor(readonly retryAfterMs: number) {
        super('Trop de tentatives, réessayez plus tard');
        this.name = 'LockedOutError';
    }
}

/** Le délai de verrouillage après `failures` échecs consécutifs. */
export function lockoutMsFor(failures: number): number {
    if (failures >= 20) return 3_600_000;
    if (failures >= 10) return 300_000;
    if (failures >= 5) return 30_000;
    return 0;
}

function keyOf(scope: AttemptScope, key: string): string {
    return `${scope}:${key}`;
}

/** Lève {@link LockedOutError} tant que la cible est verrouillée. */
export function assertAttemptAllowed(scope: AttemptScope, key: string, now = Date.now()): void {
    const entry = entries.get(keyOf(scope, key));
    if (entry && now < entry.lockedUntil) throw new LockedOutError(entry.lockedUntil - now);
}

/** Compte un échec ; renvoie le nombre d'échecs consécutifs. */
export function recordFailedAttempt(scope: AttemptScope, key: string, now = Date.now()): number {
    const k = keyOf(scope, key);
    const entry = entries.get(k) ?? { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now;
    entry.lockedUntil = now + lockoutMsFor(entry.failures);
    entries.set(k, entry);
    return entry.failures;
}

/** Un succès efface l'ardoise. */
export function clearAttempts(scope: AttemptScope, key: string): void {
    entries.delete(keyOf(scope, key));
}

/** La forme WebSocket du refus : le client affiche le délai. */
export function guardAttempt(scope: AttemptScope, key: string): void {
    try {
        assertAttemptAllowed(scope, key);
    } catch (e) {
        if (e instanceof LockedOutError) {
            throw new FeatureError('rate_limited', e.message, { retryAfterMs: e.retryAfterMs });
        }
        throw e;
    }
}

function sweep(now: number): void {
    for (const [k, entry] of entries) {
        if (now >= entry.lockedUntil && now - entry.lastFailureAt >= IDLE_MS) entries.delete(k);
    }
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Démarre l'oubli périodique des entrées inactives (idempotent, n'empêche pas l'arrêt). */
export function startAttemptSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => sweep(Date.now()), SWEEP_MS);
    sweeper.unref();
}

export function stopAttemptSweeper(): void {
    if (!sweeper) return;
    clearInterval(sweeper);
    sweeper = null;
}

/** Un balayage à l'instant donné, pour les tests. */
export function sweepAttemptsForTest(now: number): void {
    sweep(now);
}
