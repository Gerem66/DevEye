/**
 * La page affichée, en un chemin statique : la vue ouverte (`/uptime`), la
 * sous-vue qu'une feature déclare (`/audience/site/traffic`), ou la fenêtre de
 * réglages par-dessus (`/settings/uptime/notifications`). Ce que lisent le
 * suivi d'usage et le rapport de bug.
 */

const SEGMENT = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const DEBOUNCE_MS = 500;

interface Sub {
    scope: string;
    segment: string;
    order: number;
}

let root: string | null = null;
let overlay: string | null = null;
const subs = new Map<symbol, Sub>();
let order = 0;
let last: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(path: string) => void>();

/** Un identifiant en segment de chemin : `account:x-billing` devient `account/x-billing`, `apiKeys` devient `api-keys`. */
export function viewSegment(id: string): string {
    return id
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/:/g, '/');
}

function current(): string | null {
    if (overlay) return `/${overlay}`;
    if (!root) return null;
    // Seules comptent les sous-vues de la vue ouverte : une feature fermée reste
    // montée un moment, et ses écrans ne doivent pas se faire passer pour l'actuel.
    let best: Sub | null = null;
    for (const sub of subs.values()) {
        if (sub.scope !== root) continue;
        const depth = sub.segment.split('/').length;
        const bestDepth = best?.segment.split('/').length ?? 0;
        if (!best || depth > bestDepth || (depth === bestDepth && sub.order > best.order)) best = sub;
    }
    return best ? `/${root}/${best.segment}` : `/${root}`;
}

function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        const path = current();
        if (!path || path === last) return;
        last = path;
        for (const listener of listeners) listener(path);
    }, DEBOUNCE_MS);
}

export function setRootView(id: string | null): void {
    root = id === null ? null : viewSegment(id);
    schedule();
}

export function setOverlayView(path: string | null): void {
    overlay = path !== null && SEGMENT.test(path) ? path : null;
    schedule();
}

/** Une sous-vue d'une feature ; rend de quoi la retirer. Un segment qui n'est pas statique est ignoré. */
export function addSubView(scope: string, segment: string): () => void {
    if (!SEGMENT.test(segment)) {
        if (import.meta.env.DEV) console.warn(`useSubView : segment non statique ignoré (« ${segment} »)`);
        return () => undefined;
    }
    const key = Symbol(segment);
    subs.set(key, { scope: viewSegment(scope), segment, order: ++order });
    schedule();
    return () => {
        subs.delete(key);
        schedule();
    };
}

export function onView(listener: (path: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
