import { useEffect, useSyncExternalStore } from 'react';
import { SECRECY_STATE_EVENT, secrecyStatePushSchema, type SecrecyStatus } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { getActiveInstanceId } from './workspace';

/**
 * Client-side coordinator for password-based encryption. Brokers a single global
 * unlock prompt: any feature that hits a `locked` error calls
 * {@link ensureUnlocked}, which resolves once the user has supplied a password.
 * Mirrors the server's sliding grace window so the topbar can count down, and
 * drives the popup hold heartbeat (see {@link acquireSecrecyHold}).
 */
export interface SecrecyState {
    enabled: boolean;
    /** True when the session DEK is available (no prompt needed). */
    unlocked: boolean;
    prompting: boolean;
    /**
     * Epoch ms at which the grace window expires, or null when there is nothing
     * to count down: locked, feature off, "validate on every action" mode, or a
     * popup hold pausing the window.
     */
    unlockedUntil: number | null;
    /**
     * "Validate on every action" (`re_auth_interval = 0`, feature ON): the DEK is
     * never cached, so the UI routes to the config rather than offering an unlock
     * that would do nothing.
     */
    alwaysPrompt: boolean;
}

/**
 * L'invite vise le coffre d'une AUTRE instance que celle où l'on se trouve (une
 * copie vers elle) : c'est à elle que part le mot de passe, et l'ouvrir ne dit
 * rien du coffre d'ici. `null` : le coffre de l'espace actif. Hors de
 * {@link SecrecyState}, que les modules lisent : c'est l'affaire de l'hôte.
 */
export interface UnlockTarget {
    instanceId: number | null;
    label: string;
}
let unlockTarget: UnlockTarget | null = null;

/**
 * Rejection raised by {@link ensureUnlocked} when the user dismisses the prompt,
 * so callers can tell a deliberate cancel from a generic failure.
 */
export class UnlockCancelledError extends Error {
    constructor() {
        super('cancelled');
        this.name = 'UnlockCancelledError';
    }
}

/** Fallback grace window; mirrors the server's DEFAULT_DEK_GRACE_MS. */
const DEFAULT_WINDOW_MS = 60_000;

/** Popup hold heartbeat period. Must stay below the server lease
 *  (DEK_HOLD_TTL_MS) so one beat is enough to keep the DEK pinned. */
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
 * "Validate on every action" (`re_auth_interval = 0` with encryption ON). The
 * server forgets the DEK after each action, so the client must never hold the
 * session unlocked: every encrypted action re-prompts.
 */
let singleUse = false;

let graceTimer: ReturnType<typeof setTimeout> | null = null;

let holdCount = 0;
let holdBeat: ReturnType<typeof setInterval> | null = null;

function clearGraceTimer(): void {
    if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
    }
}

/**
 * (Re)start the grace countdown and publish its expiry, mirroring the server's
 * sliding TTL. A popup hold pins the DEK, so it pauses the countdown instead.
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
        // Un autre onglet de la session a pu faire glisser la fenêtre : le
        // serveur tranche, et sa lecture efface une DEK réellement expirée.
        void ws.send('secrecy.status', {}).then(
            ({ status }) => applyStatus(status),
            () => set({ unlocked: false, unlockedUntil: null })
        );
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

/** Current grace window length in ms: the full span of the countdown bar. */
export function getSecrecyWindowMs(): number {
    return windowMs;
}

const getUnlockTarget = (): UnlockTarget | null => unlockTarget;

/** Le coffre que vise l'invite ouverte ; suit `prompting`, donc le même abonnement. */
export function useUnlockTarget(): UnlockTarget | null {
    return useSyncExternalStore(subscribe, getUnlockTarget, getUnlockTarget);
}

export function useSecrecy(): SecrecyState {
    return useSyncExternalStore(subscribe, getSecrecy, getSecrecy);
}

/**
 * Toggle "validate on every action" mode. Turning it on drops any standing
 * unlock so the next encrypted action re-prompts.
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
 * `untilMs` pins the countdown to the server's exact expiry instead of resetting
 * a full window.
 */
export function setUnlocked(unlocked: boolean, untilMs?: number | null): void {
    // In "validate on every action" mode the session is never held unlocked, so
    // any unlock request collapses to locked.
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
 * match the server. No-op when locked, in "validate on every action" mode, or
 * while a popup hold has the window paused.
 */
export function touchSecrecy(): void {
    if (singleUse || holdCount > 0) return;
    if (state.unlocked) armGraceTimer();
}

/** Fire-and-forget hold heartbeat (only meaningful while the feature is on). */
function sendHold(active: boolean): void {
    // « Valider à chaque action » : rien ne se retient, pas même le temps d'une popup.
    if (!state.enabled || singleUse) return;
    void ws.send('secrecy.hold', { active }).catch(() => {});
}

/**
 * Pin the cached DEK until the returned release function is called, typically for
 * the lifetime of an open action popup: auto-lock is suspended and the server is
 * heartbeaten so the DEK survives a long edit. Refcounted, so stacked popups
 * compose. Releasing restarts a fresh grace window.
 *
 * The heartbeat is the safety net: a popup that disappears without releasing
 * (crash, navigation, dropped socket) simply stops beating and the server lease
 * lapses, so the DEK is never pinned indefinitely.
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
 * Hold the DEK while `active`. Wraps {@link acquireSecrecyHold} in an effect so
 * the release runs however the popup goes away.
 */
export function useSecrecyHold(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        return acquireSecrecyHold();
    }, [active]);
}

/**
 * Adopt an authoritative status from the server. The single place that maps
 * server truth to store state, so the UI cannot drift from it.
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
 * happened. Slides the local countdown optimistically, then reconciles with the
 * server's authoritative expiry.
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
 * Re-lock the vault ahead of the grace window: flush the cached DEK server-side,
 * then adopt the resulting status. Driven by the response and not optimistic, so
 * a failed call leaves the UI unlocked, matching the still-cached DEK.
 */
export async function lockSecrecyNow(): Promise<void> {
    if (!state.enabled || !state.unlocked) return;
    try {
        const { status } = await ws.send('secrecy.lock', {});
        applyStatus(status);
    } catch {
        // The cache may still be live: resync rather than lie about being locked.
        await refreshSecrecyStatus();
    }
}

/**
 * Resolve once the session is unlocked, opening the global prompt if needed.
 * Concurrent callers share the same prompt. Rejects if the user cancels.
 */
export function ensureUnlocked(): Promise<void> {
    if (state.unlocked) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (!state.prompting) set({ prompting: true });
    });
}

/**
 * Le coffre d'une instance précise, pour un geste qui parle à une autre que
 * l'active. On ne connaît pas son état d'ici : l'invite s'ouvre, et c'est le
 * `locked` de là-bas qui a dit qu'il le fallait.
 */
export function ensureUnlockedOn(instanceId: number | null, label: string): Promise<void> {
    if (instanceId === getActiveInstanceId()) return ensureUnlocked();
    if (state.prompting) return Promise.reject(new UnlockCancelledError());
    return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        unlockTarget = { instanceId, label };
        set({ prompting: true });
    });
}

/** Open the unlock prompt with no action waiting on it. */
export function requestUnlock(): Promise<void> {
    return ensureUnlocked();
}

/**
 * Exécute une requête qui touche une donnée chiffrée par mot de passe et, si la
 * couche répond `locked`, ouvre l'invite globale puis réessaie une fois.
 */
export async function withSecrecy<T>(run: () => Promise<T>): Promise<T> {
    try {
        const out = await run();
        touchSecrecy();
        return out;
    } catch (e) {
        if (e instanceof WsError && e.code === 'locked') {
            // Le serveur a oublié la DEK sans que ce client le sache encore.
            setUnlocked(false);
            await ensureUnlocked();
            const out = await run();
            touchSecrecy();
            return out;
        }
        throw e;
    }
}

/** Called by the dialog after a successful `secrecy.unlock`. */
export function resolveUnlock(): void {
    // Le coffre ouvert est celui d'une autre instance : celui d'ici n'a pas bougé.
    if (unlockTarget) {
        unlockTarget = null;
        set({ prompting: false });
    } else if (singleUse) {
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
    unlockTarget = null;
    set({ prompting: false });
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(new UnlockCancelledError());
}

/** Sync unlocked/enabled state from the server. */
export async function refreshSecrecyStatus(): Promise<void> {
    try {
        const { status } = await ws.send('secrecy.status', {});
        applyStatus(status);
    } catch {
        // Leave state as-is on transient errors.
    }
}

/**
 * Le serveur annonce chaque déverrouillage et chaque effacement de la DEK de la
 * session, et la relecture à chaque (re)connexion couvre ce qu'une socket
 * fermée n'a pas pu entendre, dont le changement d'instance.
 */
ws.onMessage((msg) => {
    if (msg.command !== SECRECY_STATE_EVENT || !msg.payload.ok || !state.enabled) return;
    const push = secrecyStatePushSchema.safeParse(msg.payload.data);
    if (push.success) setUnlocked(push.data.unlocked, push.data.unlockedUntil);
});
ws.onStateChange((s) => {
    if (s === 'open') void refreshSecrecyStatus();
});
