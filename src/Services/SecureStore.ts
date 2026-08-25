import { randomBytes } from 'crypto';

import { FeatureError } from '@/features/_define';
import type { Database } from '@/db';
import type { UserSecretKeyRow, WorkspaceRow } from '@deveye/types';
import Encryption from './Encryption';
import { SecretKeyService } from './SecretKeyService';

/**
 * Default "sudo-like" grace window when the user hasn't configured one: once
 * unlocked, the DEK stays available for this many ms and the timer resets on
 * every use. After it elapses without activity the DEK is wiped and the next
 * encrypted action re-prompts for the password.
 */
export const DEFAULT_DEK_GRACE_MS = 60_000;

/**
 * Safety bridge for a single-use DEK (`re_auth_interval = 0`, "validate on every
 * action"). The DEK is normally wiped as soon as the command(s) it unlocked
 * finish (see {@link exitSessionCommand}); this only bounds how long an *unused*
 * unlock lingers — long enough to bridge the unlock → action round-trip on a slow
 * link, short enough that an abandoned unlock doesn't sit in memory.
 */
const SINGLE_USE_BRIDGE_MS = 30_000;

interface DekEntry {
    dek: Buffer;
    /** Epoch ms after which the DEK is considered expired. */
    expiresAt: number;
    /**
     * The user's configured grace window in ms, used to slide the expiry on each
     * access. Mirrors `users.re_auth_interval` (seconds) at unlock time.
     */
    graceMs: number;
    /**
     * "Validate on every action" (`re_auth_interval = 0`). The DEK is not cached
     * across actions: it survives only long enough to serve the unlock-triggered
     * command(s), then is wiped as soon as they drain. Such an entry never slides
     * its expiry.
     */
    singleUse: boolean;
    /** Whether a command has actually read this single-use DEK yet. */
    consumed: boolean;
    /** In-flight commands currently holding this single-use DEK. */
    holders: number;
    /** Identity tag so a stale command's exit can't wipe a newer DEK. */
    id: number;
    /**
     * Lease deadline (epoch ms) of an active "popup hold": while `now < heldUntil`
     * the DEK is pinned and the grace window cannot flush it. Renewed by client
     * heartbeats ({@link holdSessionDek}); `0` means no hold. The lease is short
     * by design so a popup that disappears without releasing (crash, navigation)
     * lets the DEK fall back to a normal countdown within {@link DEK_HOLD_TTL_MS}.
     */
    heldUntil: number;
}

/**
 * Lease length of a single popup-hold heartbeat. The client re-sends a hold
 * every ~10s while an action popup is open; this must comfortably exceed that
 * cadence (tolerate one dropped beat) yet stay short enough that an abandoned
 * popup releases the DEK quickly. After the last beat the DEK lives at most
 * `DEK_HOLD_TTL_MS + graceMs` — never indefinitely.
 */
export const DEK_HOLD_TTL_MS = 25_000;

/** Monotonic id stamped on single-use DEK entries (see {@link DekEntry.id}). */
let dekEntrySeq = 0;

/**
 * In-memory registry of unlocked DEKs, keyed by WS sessionId. Populated only
 * when a user with password-based encryption supplies their password during a
 * session; never persisted and cleared on disconnect/logout. Server-wrapped
 * DEKs (feature OFF) are resolved on demand and never need an entry here.
 */
const sessionDeks = new Map<string, DekEntry>();

/** Wipe + drop an entry. */
function dropDek(sessionId: string, entry: DekEntry | undefined): void {
    if (!entry) return;
    entry.dek.fill(0); // best-effort wipe of key material
    sessionDeks.delete(sessionId);
}

/**
 * Read the live DEK for a session, enforcing the grace window. Returns null when
 * absent or expired (expired entries are wiped). For a normal entry each read
 * slides the expiry forward; a single-use entry never slides but records that a
 * command read it, so it can be wiped the moment that command drains.
 */
function liveDek(sessionId: string): Buffer | null {
    const entry = sessionDeks.get(sessionId);
    if (!entry) return null;
    const now = Date.now();
    // An active popup hold pins the DEK: it stays live even past expiresAt until
    // its lease lapses (see {@link holdSessionDek}).
    if (now >= entry.expiresAt && now >= entry.heldUntil) {
        dropDek(sessionId, entry);
        return null;
    }
    if (entry.singleUse) {
        entry.consumed = true;
    } else {
        entry.expiresAt = now + entry.graceMs;
    }
    return entry.dek;
}

/** True if the DEK is currently live, without sliding the grace window. */
function hasLiveDek(sessionId: string): boolean {
    const entry = sessionDeks.get(sessionId);
    if (!entry) return false;
    const now = Date.now();
    if (now >= entry.expiresAt && now >= entry.heldUntil) {
        dropDek(sessionId, entry);
        return false;
    }
    return true;
}

/**
 * Passive read of when the session's grace window expires (epoch ms), without
 * sliding it — for status polling / the topbar countdown. Returns null when the
 * DEK is absent/expired or held single-use (no meaningful countdown to show).
 */
export function peekDekExpiry(sessionId: string): number | null {
    if (!hasLiveDek(sessionId)) return null;
    const entry = sessionDeks.get(sessionId);
    if (!entry || entry.singleUse) return null;
    return entry.expiresAt;
}

/**
 * Pin or release the session DEK for an open action popup.
 *
 * `active` renews a short lease ({@link DEK_HOLD_TTL_MS}) so the DEK survives a
 * long-running popup even with no encrypted activity, and slides the underlying
 * grace window to `lease + graceMs` so releasing (or the lease simply lapsing)
 * leaves a fresh, full countdown. `!active` clears the lease and restarts a
 * fresh grace window immediately. A no-op when the session holds no DEK (locked
 * or feature off) — there is nothing to keep alive.
 */
export function holdSessionDek(sessionId: string, active: boolean, graceMs: number): void {
    const entry = sessionDeks.get(sessionId);
    if (!entry) return;
    const now = Date.now();
    // Don't resurrect an already-expired entry; if the window lapsed before the
    // first heartbeat landed, treat it as gone.
    if (now >= entry.expiresAt && now >= entry.heldUntil) {
        dropDek(sessionId, entry);
        return;
    }
    // Track the freshest configured window so a re-auth-interval change mid-popup
    // takes effect on release.
    entry.graceMs = graceMs;
    if (active) {
        entry.heldUntil = now + DEK_HOLD_TTL_MS;
        // Bound the post-popup lifetime: once heartbeats stop, the DEK lives at
        // most one lease + one fresh grace window, then flushes on its own.
        entry.expiresAt = entry.heldUntil + graceMs;
    } else {
        entry.heldUntil = 0;
        entry.expiresAt = now + graceMs;
    }
}

/**
 * Slide the grace window forward by one full interval, as if an encrypted action
 * had just occurred — backs the topbar widget's "postpone the flush" click. A
 * no-op for single-use or absent/expired entries.
 */
export function touchSessionDek(sessionId: string): void {
    const entry = sessionDeks.get(sessionId);
    if (!entry || entry.singleUse) return;
    const now = Date.now();
    if (now >= entry.expiresAt && now >= entry.heldUntil) {
        dropDek(sessionId, entry);
        return;
    }
    entry.expiresAt = now + entry.graceMs;
}

/**
 * Cache the unlocked DEK for the session under a grace window.
 *
 * @param graceMs sliding window in ms. `0` means "validate on every action": the
 *   DEK is held only as a single-use entry — enough to serve the action that
 *   triggered the unlock (a separate WS command), then wiped as soon as that
 *   command burst drains (see {@link exitSessionCommand}) or after a short safety
 *   bridge if it's never used. Defaults to {@link DEFAULT_DEK_GRACE_MS}.
 */
export function rememberSessionDek(sessionId: string, dek: Buffer, graceMs: number = DEFAULT_DEK_GRACE_MS): void {
    const prev = sessionDeks.get(sessionId);
    if (prev && prev.dek !== dek) prev.dek.fill(0);
    if (graceMs <= 0) {
        // Validate on every action: don't cache across actions, but the DEK must
        // still bridge from this unlock to the action that prompted it. Hold it
        // single-use; it's wiped as soon as that action's command drains.
        sessionDeks.set(sessionId, {
            dek,
            expiresAt: Date.now() + SINGLE_USE_BRIDGE_MS,
            graceMs: SINGLE_USE_BRIDGE_MS,
            singleUse: true,
            consumed: false,
            holders: 0,
            id: ++dekEntrySeq,
            heldUntil: 0
        });
        return;
    }
    sessionDeks.set(sessionId, {
        dek,
        expiresAt: Date.now() + graceMs,
        graceMs,
        singleUse: false,
        consumed: false,
        holders: 0,
        id: 0,
        heldUntil: 0
    });
}

export function forgetSessionDek(sessionId: string): void {
    dropDek(sessionId, sessionDeks.get(sessionId));
}

/**
 * Mark the start of a WS command for single-use DEK accounting. Returns the
 * entry's id when the session currently holds a single-use DEK (the caller must
 * then pass it to {@link exitSessionCommand}), or `0` otherwise. A no-op for
 * normal or absent DEKs.
 */
export function enterSessionCommand(sessionId: string): number {
    const entry = sessionDeks.get(sessionId);
    if (!entry || !entry.singleUse) return 0;
    entry.holders += 1;
    return entry.id;
}

/**
 * Mark the end of a WS command. Once the last in-flight command holding a
 * single-use DEK finishes — and the DEK was actually read — it is wiped so the
 * next action re-prompts. The `id` guards against a stale command wiping a DEK
 * minted by a newer unlock. Pairs with {@link enterSessionCommand}.
 */
export function exitSessionCommand(sessionId: string, ticketId: number): void {
    if (ticketId === 0) return;
    const entry = sessionDeks.get(sessionId);
    if (!entry || entry.id !== ticketId) return;
    entry.holders -= 1;
    if (entry.consumed && entry.holders <= 0) {
        dropDek(sessionId, entry);
    }
}

/**
 * Short-lived holding area for a DEK unwrapped at login time but not yet bound to
 * a WS session — the 2FA bridge. The login POST has the password (so it can
 * unwrap the DEK) but, for a 2FA account, the session is only issued after the
 * TOTP step. Rather than carrying the password through the 2FA challenge, we
 * unwrap once and stash the DEK here under an opaque, single-use token that
 * travels inside the challenge JWT. The TOTP step claims it and binds it to the
 * freshly issued session. Entries self-expire so an abandoned challenge leaks
 * nothing for long.
 */
interface PendingDek {
    userId: number;
    dek: Buffer;
    graceMs: number;
    expiresAt: number;
}

const pendingDeks = new Map<string, PendingDek>();

/** TTL for a stashed DEK; sized to the 2FA challenge window with margin. */
const PENDING_DEK_TTL_MS = 5 * 60_000;

function sweepPendingDeks(now: number): void {
    for (const [token, entry] of pendingDeks) {
        if (now >= entry.expiresAt) {
            entry.dek.fill(0);
            pendingDeks.delete(token);
        }
    }
}

/**
 * Stash a login-unwrapped DEK for an imminent 2FA completion. Returns an opaque
 * token to embed in the challenge; pass it to {@link claimPendingDek} once the
 * TOTP step issues the session. `graceMs` is carried so the eventual
 * {@link rememberSessionDek} uses the user's configured window.
 *
 * Any prior pending DEK for the same user is dropped first: a fresh login
 * supersedes an abandoned challenge (e.g. the user hit "Back" on the 2FA prompt
 * and signed in again), so stale key material never piles up across retries.
 */
export function stashPendingDek(userId: number, dek: Buffer, graceMs: number): string {
    const now = Date.now();
    sweepPendingDeks(now);
    discardPendingDeksForUser(userId);
    const token = randomBytes(18).toString('base64url');
    pendingDeks.set(token, { userId, dek, graceMs, expiresAt: now + PENDING_DEK_TTL_MS });
    return token;
}

/** Consume a stashed DEK (single use). Returns null when absent or expired. */
export function claimPendingDek(token: string): { dek: Buffer; graceMs: number } | null {
    const now = Date.now();
    sweepPendingDeks(now);
    const entry = pendingDeks.get(token);
    if (!entry) return null;
    pendingDeks.delete(token);
    if (now >= entry.expiresAt) {
        entry.dek.fill(0);
        return null;
    }
    return { dek: entry.dek, graceMs: entry.graceMs };
}

/**
 * Drop a stashed DEK without binding it, wiping its key material. For terminal
 * 2FA failures where the session won't be issued (e.g. 2FA was disabled between
 * the password step and the TOTP step) so the DEK isn't left dangling until its
 * TTL. A no-op for unknown tokens.
 */
export function discardPendingDek(token: string): void {
    const entry = pendingDeks.get(token);
    if (!entry) return;
    entry.dek.fill(0);
    pendingDeks.delete(token);
}

/** Drop every stashed DEK belonging to a user, wiping key material. */
export function discardPendingDeksForUser(userId: number): void {
    for (const [token, entry] of pendingDeks) {
        if (entry.userId === userId) {
            entry.dek.fill(0);
            pendingDeks.delete(token);
        }
    }
}

/**
 * Read/write codec for one encryption tier. Features hold a `Cipher` and never
 * see the DEK behind it.
 */
export interface Cipher {
    /** Encrypt a plaintext payload for storage. */
    encrypt(plaintext: string): Promise<string>;
    /** Decrypt a stored blob. Throws `internal` if the blob is corrupt. */
    decrypt(blob: string): Promise<string>;
    /** Non-throwing variant for tolerant list paths. */
    tryDecrypt(blob: string): Promise<string | null>;
}

/** Un {@link Cipher} assis sur une DEK résolue paresseusement. */
class DekCipher implements Cipher {
    constructor(private readonly dek: () => Promise<Buffer>) {}

    async encrypt(plaintext: string): Promise<string> {
        return SecretKeyService.encrypt(await this.dek(), plaintext);
    }

    async decrypt(blob: string): Promise<string> {
        const plain = SecretKeyService.decrypt(await this.dek(), blob);
        if (plain === null) throw new FeatureError('internal', 'Failed to decrypt content');
        return plain;
    }

    async tryDecrypt(blob: string): Promise<string | null> {
        try {
            return await this.decrypt(blob);
        } catch {
            return null;
        }
    }
}

/**
 * Ce qui décide de la clé d'un espace : sa nature et, pour un espace personnel,
 * son propriétaire. Un espace partagé a sa propre clé (WDK, posée à sa
 * création) ; un espace personnel utilise les DEK de son propriétaire, qui en
 * est le seul membre.
 */
export type WorkspaceKeyScope = Pick<WorkspaceRow, 'id' | 'kind' | 'owner_user_id'>;

/**
 * La clé de l'étage ouvert d'un espace : la WDK d'un espace partagé, la DEK
 * ouverte du propriétaire d'un espace personnel. Toutes deux sont emballées par
 * la clé serveur, donc résolubles sans session : c'est ce qui permet aux tâches
 * de fond de travailler et aux projections de partage d'être servies.
 */
function openDekOf(keys: SecretKeyService, scope: WorkspaceKeyScope): Promise<Buffer> {
    return scope.kind === 'shared' ? keys.resolveWorkspaceDek(scope.id) : keys.resolveOpenDek(scope.owner_user_id);
}

/**
 * The unified storage-encryption gateway handed to feature handlers as
 * `ctx.secure`. Features call `encrypt`/`decrypt` and never see the DEK, the
 * server key, the password or the storage of the wrapped key — this is the
 * single place that turns plaintext into a stored blob and back.
 *
 * Scoped to one (workspace, session), it exposes two tiers:
 *  - the store itself — the **guarded** tier. In a personal workspace it is
 *    keyed by the owner's main DEK: when password encryption is on, reading or
 *    writing it requires a live session unlock (`locked` otherwise). Default
 *    for feature data.
 *  - {@link open} — the **open** tier, keyed by a DEK the server can always
 *    unwrap. For data a feature must serve with no prompt at all, while still
 *    being encrypted at rest.
 *
 * In a shared workspace both tiers resolve the workspace's own key (WDK),
 * server-wrapped: every member reads the workspace without depending on
 * anyone's password, and there is nothing to unlock.
 */
export class SecureStore implements Cipher {
    private cachedRow: UserSecretKeyRow | null = null;
    private cachedOpenDek: Promise<Buffer> | null = null;

    /**
     * Always-available tier. Deliberately not gated: anything written here is
     * readable by the live server, so only put data whose exposure the user has
     * accepted (e.g. a note not marked private).
     */
    readonly open: Cipher = new DekCipher(() => this.resolveOpenDek());

    /** Password-gated tier backing this store's own encrypt/decrypt. */
    private readonly guarded: Cipher = new DekCipher(() => this.resolveDek());

    constructor(
        private readonly keys: SecretKeyService,
        private readonly scope: WorkspaceKeyScope,
        private readonly sessionId: string
    ) {}

    /** La ligne de clés du propriétaire : l'étage gardé d'un espace personnel. */
    private async row(): Promise<UserSecretKeyRow> {
        if (!this.cachedRow) this.cachedRow = await this.keys.ensureRow(this.scope.owner_user_id);
        return this.cachedRow;
    }

    /** Invalidate the cached row after a wrap-mode change within the session. */
    invalidate(): void {
        this.cachedRow = null;
    }

    /**
     * The open DEK, resolved once per connection: it is neither password-gated
     * nor affected by a wrap-mode change, so unlike {@link cachedRow} it never
     * needs invalidating. Caching the promise also collapses the concurrent
     * first uses of a listing into a single lookup. A failure is not cached.
     */
    private resolveOpenDek(): Promise<Buffer> {
        this.cachedOpenDek ??= openDekOf(this.keys, this.scope).catch((e: unknown) => {
            this.cachedOpenDek = null;
            throw e;
        });
        return this.cachedOpenDek;
    }

    /**
     * Resolve the guarded DEK for this session, or throw a typed error the
     * dispatcher turns into a client-actionable response:
     *  - shared workspace → the WDK, nothing to unlock.
     *  - feature OFF → unwrap with the server key transparently.
     *  - feature ON, session unlocked → use the cached DEK.
     *  - feature ON, locked → `FeatureError('locked')` so the client prompts.
     */
    private async resolveDek(): Promise<Buffer> {
        // La clé d'un espace partagé sert aussi l'étage gardé : emballée par la
        // clé serveur, un second niveau serait déballable de la même façon et
        // n'apporterait rien. Chaque membre lit l'espace sans dépendre du mot de
        // passe d'un autre.
        if (this.scope.kind === 'shared') return this.resolveOpenDek();
        const row = await this.row();
        if (!this.keys.isPasswordWrapped(row)) {
            return this.keys.resolveServerDek(row);
        }
        const dek = liveDek(this.sessionId);
        if (!dek) {
            throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
        }
        return dek;
    }

    /**
     * L'étage gardé est-il lisible sans invite ? Toujours dans un espace
     * partagé ; dans un espace personnel, dès que la clé n'est pas emballée par
     * le mot de passe, sinon selon `probe` (le déverrouillage de session).
     */
    private async unlockedBy(probe: (sessionId: string) => boolean): Promise<boolean> {
        if (this.scope.kind === 'shared') return true;
        const row = await this.row();
        return !this.keys.isPasswordWrapped(row) || probe(this.sessionId);
    }

    /**
     * True when encrypted data can be read/written right now without a prompt.
     * Note: this also slides the grace window forward (treated as activity), so
     * call it only as part of a real access check, not for passive polling.
     */
    isUnlocked(): Promise<boolean> {
        return this.unlockedBy((sessionId) => liveDek(sessionId) !== null);
    }

    /**
     * Like {@link isUnlocked} but does NOT slide the grace window — for status
     * polling that must not count as user activity.
     */
    isUnlockedPassive(): Promise<boolean> {
        return this.unlockedBy(hasLiveDek);
    }

    /** Encrypt a plaintext payload for storage. */
    async encrypt(plaintext: string): Promise<string> {
        return this.guarded.encrypt(plaintext);
    }

    /** Decrypt a stored blob. Throws `internal` if the blob is corrupt. */
    async decrypt(blob: string): Promise<string> {
        return this.guarded.decrypt(blob);
    }

    /** Non-throwing decrypt for tolerant list paths. */
    tryDecrypt(blob: string): Promise<string | null> {
        return this.guarded.tryDecrypt(blob);
    }
}

/**
 * Fabrique utilisée par le dispatcheur WS pour bâtir `ctx.secure`, scopé à
 * `(espace, session)`.
 */
export function createSecureStore(
    db: Database,
    crypt: Encryption,
    scope: WorkspaceKeyScope,
    sessionId: string
): { store: SecureStore; keys: SecretKeyService } {
    const keys = new SecretKeyService(db, crypt);
    return { store: new SecureStore(keys, scope, sessionId), keys };
}

/**
 * L'étage **ouvert** d'un espace, sans session derrière : pour les tâches de
 * fond qui lisent ou écrivent alors que personne n'est connecté (ordonnanceur
 * uptime, synchro mail), et pour servir un élément projeté depuis son espace
 * d'origine. Seul cet étage est atteignable ainsi, par construction : l'étage
 * gardé exige un déverrouillage de session et n'aurait ici aucun sens.
 */
export function createOpenCipher(db: Database, crypt: Encryption, workspaceId: number): Cipher {
    const keys = new SecretKeyService(db, crypt);
    return new DekCipher(async () => {
        const workspace = await db.workspaces.findById(workspaceId);
        if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
        return openDekOf(keys, workspace);
    });
}
