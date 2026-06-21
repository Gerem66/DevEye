/**
 * One-shot "the dashboard has its essential first data" signal.
 *
 * The login splash holds its fade-out until this fires, so the progress-bar
 * animation always finishes onto a populated home rather than a half-empty grid.
 * HomePage marks it ready once the device list (its above-the-fold content) has
 * resolved; the splash also caps the wait so a stalled load can't trap the user.
 *
 * Reset on logout / session loss so the next sign-in waits afresh.
 */
let ready = false;
const listeners = new Set<() => void>();

export function isHomeReady(): boolean {
    return ready;
}

export function markHomeReady(): void {
    if (ready) return;
    ready = true;
    for (const fn of listeners) fn();
}

export function resetHomeReady(): void {
    ready = false;
}

/** Subscribe to the next ready transition. Returns an unsubscribe function. */
export function onHomeReady(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
