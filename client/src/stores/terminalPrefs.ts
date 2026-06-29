import { useSyncExternalStore } from 'react';

/**
 * Local preferences for the remote terminal (per browser, not synced). Kept tiny
 * and self-contained: a default account to open sessions under, and what to do
 * when the shell exits.
 */
const KEY = 'deveye:terminal';

export interface TerminalPrefs {
    /**
     * Account to open new sessions under. Empty → the account the agent itself runs
     * as. Restricted to safe username chars when sent (see `terminalUser` in types).
     */
    defaultUser: string;
    /**
     * On shell exit: `true` (default) closes the popup straight away; `false` keeps
     * it open with a "Relancer"/"Fermer" banner.
     */
    closeOnExit: boolean;
}

const DEFAULT: TerminalPrefs = { defaultUser: '', closeOnExit: true };

function load(): TerminalPrefs {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const parsed = JSON.parse(raw) as Partial<TerminalPrefs>;
        return {
            defaultUser: typeof parsed.defaultUser === 'string' ? parsed.defaultUser : DEFAULT.defaultUser,
            closeOnExit: typeof parsed.closeOnExit === 'boolean' ? parsed.closeOnExit : DEFAULT.closeOnExit
        };
    } catch {
        return DEFAULT;
    }
}

let state: TerminalPrefs = load();
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

/** Merge a partial update, persist it, and notify subscribers. */
export function setTerminalPrefs(patch: Partial<TerminalPrefs>): void {
    state = { ...state, ...patch };
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        /* storage unavailable (private mode / quota): keep the in-memory value */
    }
    emit();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): TerminalPrefs {
    return state;
}

/** Read the current terminal preferences without subscribing (for one-shot reads). */
export function getTerminalPrefs(): TerminalPrefs {
    return state;
}

/** Reactive terminal preferences. */
export function useTerminalPrefs(): TerminalPrefs {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
