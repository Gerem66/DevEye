import { randomBytes } from 'crypto';

import { FeatureError } from '@/features/_define';
import type { Database } from '@/db';
import type { UserSecretKeyRow } from 'deveye-types';
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
}

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
    if (Date.now() >= entry.expiresAt) {
        dropDek(sessionId, entry);
        return null;
    }
    if (entry.singleUse) {
        entry.consumed = true;
    } else {
        entry.expiresAt = Date.now() + entry.graceMs;
    }
    return entry.dek;
}

/** True if the DEK is currently live, without sliding the grace window. */
function hasLiveDek(sessionId: string): boolean {
    const entry = sessionDeks.get(sessionId);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
        dropDek(sessionId, entry);
        return false;
    }
    return true;
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
            id: ++dekEntrySeq
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
        id: 0
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
 * The unified storage-encryption gateway handed to feature handlers as
 * `ctx.secure`. Features call `encrypt`/`decrypt` and never see the DEK, the
 * server key, the password or the storage of the wrapped key — this is the
 * single place that turns plaintext into a stored blob and back.
 *
 * Scoped to one (user, session): it resolves the right DEK based on whether the
 * feature is on (password-wrapped) or off (server-wrapped).
 */
export class SecureStore {
    private cachedRow: UserSecretKeyRow | null = null;

    constructor(
        private readonly keys: SecretKeyService,
        private readonly userId: number,
        private readonly sessionId: string,
        private readonly crypt: Encryption
    ) {}

    private async row(): Promise<UserSecretKeyRow> {
        if (!this.cachedRow) this.cachedRow = await this.keys.ensureRow(this.userId);
        return this.cachedRow;
    }

    /** Invalidate the cached row after a wrap-mode change within the session. */
    invalidate(): void {
        this.cachedRow = null;
    }

    /**
     * Resolve the DEK for this session, or throw a typed error the dispatcher
     * turns into a client-actionable response:
     *  - feature OFF → unwrap with the server key transparently.
     *  - feature ON, session unlocked → use the cached DEK.
     *  - feature ON, locked → `FeatureError('locked')` so the client prompts.
     */
    private async resolveDek(): Promise<Buffer> {
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
     * True when encrypted data can be read/written right now without a prompt.
     * Note: this also slides the grace window forward (treated as activity), so
     * call it only as part of a real access check, not for passive polling.
     */
    async isUnlocked(): Promise<boolean> {
        const row = await this.row();
        if (!this.keys.isPasswordWrapped(row)) return true;
        return liveDek(this.sessionId) !== null;
    }

    /**
     * Like {@link isUnlocked} but does NOT slide the grace window — for status
     * polling that must not count as user activity.
     */
    async isUnlockedPassive(): Promise<boolean> {
        const row = await this.row();
        if (!this.keys.isPasswordWrapped(row)) return true;
        return hasLiveDek(this.sessionId);
    }

    /** Encrypt a plaintext payload for storage. */
    async encrypt(plaintext: string): Promise<string> {
        const dek = await this.resolveDek();
        return SecretKeyService.encrypt(dek, plaintext);
    }

    /** Decrypt a stored blob. Throws `internal` if the blob is corrupt. */
    async decrypt(blob: string): Promise<string> {
        const dek = await this.resolveDek();
        const plain = SecretKeyService.decrypt(dek, blob);
        if (plain === null) throw new FeatureError('internal', 'Failed to decrypt content');
        return plain;
    }

    /**
     * Non-throwing decrypt for tolerant list paths. Tries the new GCM format
     * first; falls back to the legacy CTR+HMAC format for rows written before
     * the envelope-encryption layer was introduced.
     */
    async tryDecrypt(blob: string): Promise<string | null> {
        try {
            return await this.decrypt(blob);
        } catch {
            // Legacy fallback: data written with the old Encryption.Encrypt scheme.
            return this.crypt.Decrypt(blob);
        }
    }
}

/** Factory wiring used by the WS dispatcher to build `ctx.secure` per session. */
export function createSecureStore(
    db: Database,
    crypt: Encryption,
    userId: number,
    sessionId: string
): { store: SecureStore; keys: SecretKeyService } {
    const keys = new SecretKeyService(db, crypt);
    return { store: new SecureStore(keys, userId, sessionId, crypt), keys };
}
