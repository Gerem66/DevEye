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

let state: SecrecyState = { unlocked: false, prompting: false };
const listeners = new Set<() => void>();

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

/** Mark the session unlocked/locked from anywhere (status sync, logout, …). */
export function setUnlocked(unlocked: boolean): void {
    set({ unlocked });
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
    set({ unlocked: true, prompting: false });
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.resolve();
}

/** Called by the dialog when the user cancels the prompt. */
export function cancelUnlock(): void {
    set({ prompting: false });
    const pending = waiters;
    waiters = [];
    for (const w of pending) w.reject(new Error('cancelled'));
}

/**
 * Sync unlocked/enabled state from the server. Safe to call after connect and
 * after any secrecy mutation.
 */
export async function refreshSecrecyStatus(): Promise<void> {
    try {
        const { status } = await ws.send('secrecy.status', {});
        // When the feature is off, treat the session as always unlocked.
        set({ unlocked: !status.enabled || status.unlocked });
    } catch {
        // Leave state as-is on transient errors.
    }
}
