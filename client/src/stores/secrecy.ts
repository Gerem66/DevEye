import { useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';

/**
 * Client-side coordinator for password-based encryption ("chiffrement par mot
 * de passe"). Holds whether the current WS session is unlocked and brokers a
 * single global unlock prompt: any feature that hits a `locked` error calls
 * {@link ensureUnlocked} which opens the dialog and resolves once the user has
 * supplied their password.
 */
export interface SecrecyState {
    /** True when the session DEK is available (no prompt needed). */
    unlocked: boolean;
    /** Whether the unlock dialog is currently open. */
    prompting: boolean;
}

/**
 * Rejection raised by {@link ensureUnlocked} when the user dismisses the unlock
 * prompt without entering their password. Callers can detect it to react to a
 * deliberate cancel (e.g. close a feature that has nothing to show) instead of
 * treating it as a generic failure.
 */
export class UnlockCancelledError extends Error {
    constructor() {
        super('cancelled');
        this.name = 'UnlockCancelledError';
    }
}

/**
 * Client mirror of the server's "sudo-like" grace window (see SecureStore on the
 * backend). Must stay <= the server value so the client re-prompts proactively
 * instead of firing a request that fails with `locked`.
 */
const GRACE_MS = 60_000;

let state: SecrecyState = { unlocked: false, prompting: false };
const listeners = new Set<() => void>();

/**
 * "Validate on every action" mode (`re_auth_interval = 0` with encryption ON).
 * The server forgets the DEK right after each action, so the client must never
 * hold the session as persistently unlocked: every encrypted action re-prompts.
 */
let singleUse = false;

/** Timer that flips `unlocked` back to false once the grace window elapses. */
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function clearGraceTimer(): void {
    if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
    }
}

/**
 * Restart the grace countdown. Called on unlock and on every subsequent
 * encrypted action (see {@link touchSecrecy}) to mirror the server's sliding TTL.
 */
function armGraceTimer(): void {
    clearGraceTimer();
    graceTimer = setTimeout(() => {
        graceTimer = null;
        set({ unlocked: false });
    }, GRACE_MS);
}

/** Promises waiting on the in-flight unlock prompt. */
type Waiter = { resolve: () => void; reject: (e: Error) => void };
let waiters: Waiter[] = [];

function emit(): void {
    for (const fn of listeners) fn();
}

function set(patch: Partial<SecrecyState>): void {
    state = { ...state, ...patch };
    emit();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function getSecrecy(): SecrecyState {
    return state;
}

export function useSecrecy(): SecrecyState {
    return useSyncExternalStore(subscribe, getSecrecy, getSecrecy);
}

/**
 * Toggle "validate on every action" mode. Turning it on drops any standing
 * unlock so the very next encrypted action re-prompts.
 */
export function setSingleUse(on: boolean): void {
    singleUse = on;
    if (on) {
        clearGraceTimer();
        set({ unlocked: false });
    }
}

/** Mark the session unlocked/locked from anywhere (status sync, logout, …). */
export function setUnlocked(unlocked: boolean): void {
    // In "validate on every action" mode the session is never held unlocked:
    // each encrypted action must re-prompt (the server forgets the DEK between
    // actions), so collapse any unlock request to locked.
    const effective = unlocked && !singleUse;
    if (effective) armGraceTimer();
    else clearGraceTimer();
    set({ unlocked: effective });
}

/**
 * Signal an encrypted action just happened: slides the grace window forward to
 * match the server. No-op when already locked (the next action will prompt) or
 * in "validate on every action" mode (nothing is cached).
 */
export function touchSecrecy(): void {
    if (singleUse) return;
    if (state.unlocked) armGraceTimer();
}

/**
 * Resolve once the session is unlocked, opening the global prompt if needed.
 * Multiple concurrent callers share the same prompt. Rejects if the user
 * cancels.
 */
export function ensureUnlocked(): Promise<void> {
    if (state.unlocked) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (!state.prompting) set({ prompting: true });
    });
}

/** Called by the dialog after a successful `secrecy.unlock`. */
export function resolveUnlock(): void {
    // Release the waiting action(s). In "validate on every action" mode we don't
    // keep the session unlocked afterwards — the next action prompts again.
    if (singleUse) {
        set({ prompting: false });
    } else {
        armGraceTimer();
        set({ unlocked: true, prompting: false });
    }
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.resolve();
}

/** Called by the dialog when the user cancels the prompt. */
export function cancelUnlock(): void {
    set({ prompting: false });
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(new UnlockCancelledError());
}

/**
 * Sync unlocked/enabled state from the server. Safe to call after connect and
 * after any secrecy mutation.
 */
export async function refreshSecrecyStatus(): Promise<void> {
    try {
        const { status } = await ws.send('secrecy.status', {});
        // `re_auth_interval === 0` with encryption ON = validate on every action.
        setSingleUse(status.enabled && status.reAuthInterval === 0);
        // When the feature is off, treat the session as always unlocked.
        setUnlocked(!status.enabled || status.unlocked);
    } catch {
        // Leave state as-is on transient errors.
    }
}
