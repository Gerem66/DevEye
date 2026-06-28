import { useEffect, useSyncExternalStore } from 'react';
import type { SecrecyStatus } from 'deveye-types';

import { ws } from '@/api/ws';

/**
 * Client-side coordinator for password-based encryption ("chiffrement par mot
 * de passe"). Holds whether the current WS session is unlocked and brokers a
 * single global unlock prompt: any feature that hits a `locked` error calls
 * {@link ensureUnlocked} which opens the dialog and resolves once the user has
 * supplied their password.
 *
 * It also mirrors the server's sliding grace window so the topbar timer widget
 * can render a live countdown, and drives the **popup hold** heartbeat (see
 * {@link acquireSecrecyHold}) that keeps the DEK alive while an action popup is
 * open and restarts a fresh window the moment it closes.
 */
export interface SecrecyState {
    /** True when password-based encryption is enabled for the account. */
    enabled: boolean;
    /** True when the session DEK is available (no prompt needed). */
    unlocked: boolean;
    /** Whether the unlock dialog is currently open. */
    prompting: boolean;
    /**
     * Epoch ms at which the grace window expires (for the countdown), or null
     * when there is nothing to count down: locked, feature off, "validate on
     * every action" mode, or while a popup hold has paused the window.
     */
    unlockedUntil: number | null;
    /**
     * "Validate on every action" (`re_auth_interval = 0`, feature ON): the DEK is
     * never cached, so unlocking ahead of time is pointless. Surfaced so the UI
     * can route to the config instead of offering a no-op unlock.
     */
    alwaysPrompt: boolean;
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
 * Default grace window when the user hasn't configured one — mirrors the
 * server's DEFAULT_DEK_GRACE_MS. The live value tracks `re_auth_interval`.
 */
const DEFAULT_WINDOW_MS = 60_000;

/** How often the popup hold heartbeats the server while a popup stays open. Must
 *  stay below the server lease (DEK_HOLD_TTL_MS) so one beat keeps the DEK pinned. */
const HOLD_BEAT_MS = 10_000;

let state: SecrecyState = {
    enabled: false,
    unlocked: false,
    prompting: false,
    unlockedUntil: null,
    alwaysPrompt: false
};
const listeners = new Set<() => void>();

/** Live grace window in ms, derived from the user's configured re-auth interval. */
let windowMs = DEFAULT_WINDOW_MS;

/**
 * "Validate on every action" mode (`re_auth_interval = 0` with encryption ON).
 * The server forgets the DEK right after each action, so the client must never
 * hold the session as persistently unlocked: every encrypted action re-prompts.
 */
let singleUse = false;

/** Timer that flips `unlocked` back to false once the grace window elapses. */
let graceTimer: ReturnType<typeof setTimeout> | null = null;

/** Active popup-hold count + its server heartbeat (see {@link acquireSecrecyHold}). */
let holdCount = 0;
let holdBeat: ReturnType<typeof setInterval> | null = null;

function clearGraceTimer(): void {
    if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
    }
}

/**
 * (Re)start the grace countdown for `durationMs` and publish its expiry. Called
 * on unlock and on every subsequent encrypted action (see {@link touchSecrecy})
 * to mirror the server's sliding TTL. A no-op countdown while a popup hold is
 * active — the hold pins the DEK and pauses the visible countdown.
 */
function armGraceTimer(durationMs: number = windowMs): void {
    clearGraceTimer();
    if (holdCount > 0) {
        set({ unlockedUntil: null });
        return;
    }
    const safe = Math.max(1000, durationMs);
    set({ unlockedUntil: Date.now() + safe });
    graceTimer = setTimeout(() => {
        graceTimer = null;
        set({ unlocked: false, unlockedUntil: null });
    }, safe);
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

/** Current grace window length in ms — the full span of the countdown bar. */
export function getSecrecyWindowMs(): number {
    return windowMs;
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
        set({ unlocked: false, unlockedUntil: null, alwaysPrompt: true });
    } else {
        set({ alwaysPrompt: false });
    }
}

/**
 * Mark the session unlocked/locked from anywhere (status sync, logout, …).
 * `untilMs` optionally pins the countdown to the server's exact expiry instead
 * of resetting a full window (used by the status sync).
 */
export function setUnlocked(unlocked: boolean, untilMs?: number | null): void {
    // In "validate on every action" mode the session is never held unlocked:
    // each encrypted action must re-prompt (the server forgets the DEK between
    // actions), so collapse any unlock request to locked.
    const effective = unlocked && !singleUse;
    if (effective) {
        set({ unlocked: true });
        const remaining = untilMs && untilMs > Date.now() ? untilMs - Date.now() : windowMs;
        armGraceTimer(remaining);
    } else {
        clearGraceTimer();
        set({ unlocked: false, unlockedUntil: null });
    }
}

/**
 * Signal an encrypted action just happened: slides the grace window forward to
 * match the server. No-op when already locked (the next action will prompt), in
 * "validate on every action" mode (nothing is cached), or while a popup hold has
 * the window paused.
 */
export function touchSecrecy(): void {
    if (singleUse || holdCount > 0) return;
    if (state.unlocked) armGraceTimer();
}

/** Fire-and-forget hold heartbeat (only meaningful while the feature is on). */
function sendHold(active: boolean): void {
    if (!state.enabled) return;
    void ws.send('secrecy.hold', { active }).catch(() => {});
}

/**
 * Pin the cached DEK for as long as the returned release function is uncalled —
 * for the lifetime of an open action popup. While held, the client suspends its
 * auto-lock and heartbeats the server so the DEK survives a long edit; releasing
 * (popup closed for ANY reason) stops the heartbeat, tells the server to release,
 * and restarts a fresh grace window. Refcounted so nested/stacked popups compose.
 *
 * The heartbeat is the safety net: if a popup disappears without releasing
 * (crash, navigation, dropped socket), the beats simply stop and the server
 * lease lapses, so the DEK is never pinned indefinitely.
 */
export function acquireSecrecyHold(): () => void {
    holdCount += 1;
    if (holdCount === 1) {
        clearGraceTimer();
        set({ unlockedUntil: null });
        sendHold(true);
        holdBeat = setInterval(() => sendHold(true), HOLD_BEAT_MS);
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holdCount = Math.max(0, holdCount - 1);
        if (holdCount === 0) {
            if (holdBeat) {
                clearInterval(holdBeat);
                holdBeat = null;
            }
            sendHold(false);
            if (state.unlocked && !singleUse) armGraceTimer();
        }
    };
}

/**
 * Hold the DEK while `active` (typically a popup's open state). Wraps
 * {@link acquireSecrecyHold} in an effect so the release runs on unmount /
 * deactivation regardless of how the popup goes away.
 */
export function useSecrecyHold(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        return acquireSecrecyHold();
    }, [active]);
}

/**
 * Adopt an authoritative status from the server (the response of any secrecy
 * command). The single place that maps server truth → store state, so the widget
 * can never drift from what the server actually did.
 */
function applyStatus(status: SecrecyStatus): void {
    // `re_auth_interval === 0` with encryption ON = validate on every action.
    windowMs = status.reAuthInterval && status.reAuthInterval > 0 ? status.reAuthInterval * 1000 : DEFAULT_WINDOW_MS;
    set({ enabled: status.enabled });
    setSingleUse(status.enabled && status.reAuthInterval === 0);
    // When the feature is off, treat the session as always unlocked.
    setUnlocked(!status.enabled || status.unlocked, status.unlockedUntil);
}

/**
 * Postpone the password flush by one full window, as if an encrypted action had
 * happened — backs the topbar timer widget's click. Slides the local countdown
 * optimistically, then reconciles with the server's authoritative expiry.
 */
export async function postponeSecrecyFlush(): Promise<void> {
    if (!state.enabled || !state.unlocked || singleUse) return;
    touchSecrecy();
    try {
        const { status } = await ws.send('secrecy.touch', {});
        applyStatus(status);
    } catch {
        // Keep the optimistic local slide on transient errors.
    }
}

/**
 * Immediately re-lock the vault: flush the cached DEK server-side, then adopt the
 * server's resulting status. Driven by the response (not optimistic) so the
 * widget always reflects whether the cache was *actually* cleared — if the call
 * fails, the widget stays unlocked, matching the still-cached DEK. Backs the
 * topbar widget's padlock click (force a re-lock ahead of the grace window).
 */
export async function lockSecrecyNow(): Promise<void> {
    if (!state.enabled || !state.unlocked) return;
    try {
        const { status } = await ws.send('secrecy.lock', {});
        applyStatus(status);
    } catch {
        // The cache may still be live — resync rather than lie about being locked.
        await refreshSecrecyStatus();
    }
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

/** Open the unlock prompt directly (e.g. from the topbar lock widget), even
 *  when no action is waiting. Resolves/rejects like {@link ensureUnlocked}. */
export function requestUnlock(): Promise<void> {
    return ensureUnlocked();
}

/** Called by the dialog after a successful `secrecy.unlock`. */
export function resolveUnlock(): void {
    // Release the waiting action(s). In "validate on every action" mode we don't
    // keep the session unlocked afterwards — the next action prompts again.
    if (singleUse) {
        set({ prompting: false });
    } else {
        set({ unlocked: true, prompting: false });
        armGraceTimer();
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
        applyStatus(status);
    } catch {
        // Leave state as-is on transient errors.
    }
}
