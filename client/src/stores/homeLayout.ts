import { useSyncExternalStore } from 'react';
import {
    homeLayoutSchema,
    type HomeCategory,
    type HomeCategoryKind,
    type HomeFeatureId,
    type HomeLayout,
    type HomeTopbarWidgetId,
    type ShortcutItem,
    type ShortcutTemplate
} from 'deveye-types';
import { ws } from '@/api/ws';

/**
 * Home grid layout: ordered **categories** (Devices / Features / Shortcuts),
 * each holding ordered tiles of its kind. Persisted in localStorage for an
 * instant paint, and synced to the server (debounced) so the arrangement follows
 * the user across devices. Mirrors {@link ./theme}.
 *
 * Holds only non-sensitive personalization metadata (feature ids, device ids,
 * pinned link objects) — never zero-knowledge payload.
 */
const KEY = 'deveye:homeLayout';

/** Canonical category order, used to seed defaults and append missing ones. */
const CANONICAL_KINDS: HomeCategoryKind[] = ['device', 'feature', 'shortcut', 'topbar'];
/** Default feature tiles for a fresh user, in their historical grid order. */
const DEFAULT_FEATURES: HomeFeatureId[] = ['monitoring', 'weather', 'password', 'notes'];

function uid(): string {
    return crypto.randomUUID();
}

function emptyCategory(kind: HomeCategoryKind): HomeCategory {
    return { kind, items: [] };
}

function defaultLayout(): HomeLayout {
    return {
        categories: [
            { kind: 'device', items: [] },
            { kind: 'feature', items: [...DEFAULT_FEATURES] },
            { kind: 'shortcut', items: [] },
            // Topbar mini-widgets default to none — the navbar shows them only once
            // the user opts in via "Organiser l'accueil".
            { kind: 'topbar', items: [] }
        ]
    };
}

/**
 * Ensure every known category exists exactly once, preserving saved order and
 * appending any missing one in canonical order. Keeps the UI robust against
 * partial / older layouts (a category that didn't exist yet just shows empty).
 */
function normalize(layout: HomeLayout): HomeLayout {
    const seen = new Map<HomeCategoryKind, HomeCategory>();
    for (const cat of layout.categories) {
        if (!seen.has(cat.kind)) seen.set(cat.kind, cat);
    }
    const categories = [...seen.values()];
    for (const kind of CANONICAL_KINDS) {
        if (!seen.has(kind)) categories.push(emptyCategory(kind));
    }
    return { categories };
}

function read(): HomeLayout {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return defaultLayout();
        const parsed = homeLayoutSchema.safeParse(JSON.parse(raw));
        return parsed.success ? normalize(parsed.data) : defaultLayout();
    } catch {
        return defaultLayout();
    }
}

let state: HomeLayout = read();
const listeners = new Set<() => void>();

function persist(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // ignore (private mode, quota, etc.)
    }
}

// Debounced server sync: coalesce rapid edits (a drag, several adds) into one WS call.
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncToServer(): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        if (ws.state !== 'open') return;
        void ws.send('home.setLayout', state).catch(() => {});
    }, 800);
}

function commit(next: HomeLayout): void {
    state = next;
    persist();
    scheduleSyncToServer();
    for (const fn of listeners) fn();
}

/** Replace a single category (matched by kind), keeping the others/order intact. */
function replaceCategory(kind: HomeCategoryKind, items: HomeCategory['items']): void {
    commit({
        categories: state.categories.map((c) => (c.kind === kind ? ({ kind: c.kind, items } as HomeCategory) : c))
    });
}

export function getHomeLayout(): HomeLayout {
    return state;
}

export function findCategory<K extends HomeCategoryKind>(
    layout: HomeLayout,
    kind: K
): Extract<HomeCategory, { kind: K }> | undefined {
    return layout.categories.find((c) => c.kind === kind) as Extract<HomeCategory, { kind: K }> | undefined;
}

// ── Category ordering ──────────────────────────────────────────────────────
export function setCategoryOrder(kinds: HomeCategoryKind[]): void {
    const byKind = new Map(state.categories.map((c) => [c.kind, c]));
    const reordered = kinds.map((k) => byKind.get(k)).filter((c): c is HomeCategory => !!c);
    // Guard: keep any category not present in `kinds` (shouldn't happen) at the end.
    for (const c of state.categories) if (!kinds.includes(c.kind)) reordered.push(c);
    commit({ categories: reordered });
}

// ── Tile ordering within a category (after a drag) ─────────────────────────
export function setFeatureOrder(items: HomeFeatureId[]): void {
    replaceCategory('feature', items);
}
export function setDeviceOrder(items: string[]): void {
    replaceCategory('device', items);
}
export function setShortcutOrder(items: ShortcutItem[]): void {
    replaceCategory('shortcut', items);
}
export function setTopbarOrder(items: HomeTopbarWidgetId[]): void {
    replaceCategory('topbar', items);
}

// ── Add / remove ───────────────────────────────────────────────────────────
export function addFeature(featureId: HomeFeatureId): void {
    const cat = findCategory(state, 'feature');
    if (!cat || cat.items.includes(featureId)) return;
    replaceCategory('feature', [...cat.items, featureId]);
}
export function removeFeature(featureId: HomeFeatureId): void {
    const cat = findCategory(state, 'feature');
    if (!cat) return;
    replaceCategory(
        'feature',
        cat.items.filter((id) => id !== featureId)
    );
}

export function addTopbarWidget(id: HomeTopbarWidgetId): void {
    const cat = findCategory(state, 'topbar');
    if (!cat || cat.items.includes(id)) return;
    replaceCategory('topbar', [...cat.items, id]);
}
export function removeTopbarWidget(id: HomeTopbarWidgetId): void {
    const cat = findCategory(state, 'topbar');
    if (!cat) return;
    replaceCategory(
        'topbar',
        cat.items.filter((w) => w !== id)
    );
}

export function addDevice(deviceId: string): void {
    const cat = findCategory(state, 'device');
    if (!cat || cat.items.includes(deviceId)) return;
    replaceCategory('device', [...cat.items, deviceId]);
}
export function removeDevice(deviceId: string): void {
    const cat = findCategory(state, 'device');
    if (!cat) return;
    replaceCategory(
        'device',
        cat.items.filter((id) => id !== deviceId)
    );
}

export interface ShortcutDraft {
    template: ShortcutTemplate;
    url: string;
    title: string;
    description?: string;
    icon?: string;
}
export function addShortcut(draft: ShortcutDraft): void {
    const cat = findCategory(state, 'shortcut');
    if (!cat) return;
    const item: ShortcutItem = {
        id: uid(),
        template: draft.template,
        url: draft.url,
        title: draft.title,
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.icon ? { icon: draft.icon } : {})
    };
    replaceCategory('shortcut', [...cat.items, item]);
}
export function updateShortcut(id: string, draft: ShortcutDraft): void {
    const cat = findCategory(state, 'shortcut');
    if (!cat) return;
    replaceCategory(
        'shortcut',
        cat.items.map((s) =>
            s.id === id
                ? {
                      id,
                      template: draft.template,
                      url: draft.url,
                      title: draft.title,
                      ...(draft.description ? { description: draft.description } : {}),
                      ...(draft.icon ? { icon: draft.icon } : {})
                  }
                : s
        )
    );
}

export function removeShortcut(id: string): void {
    const cat = findCategory(state, 'shortcut');
    if (!cat) return;
    replaceCategory(
        'shortcut',
        cat.items.filter((s) => s.id !== id)
    );
}

/**
 * Drop device tiles whose device no longer exists (deleted). No-op when nothing
 * is stale. Only call once devices have actually loaded, so a transient empty
 * list can't wipe the layout.
 */
export function pruneMissingDevices(validDeviceIds: Set<string>): void {
    const cat = findCategory(state, 'device');
    if (!cat) return;
    const items = cat.items.filter((id) => validDeviceIds.has(id));
    if (items.length !== cat.items.length) replaceCategory('device', items);
}

/**
 * Called by AuthProvider when a user bundle arrives. The server copy wins over
 * localStorage so the layout propagates across devices; skipped when the server
 * has none (fresh / legacy user) so the local default (or last local edit) stands.
 */
export function syncHomeLayoutFromServer(serverLayout: HomeLayout | null): void {
    if (!serverLayout) return;
    state = normalize(serverLayout);
    persist();
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function useHomeLayout(): HomeLayout {
    return useSyncExternalStore(subscribe, getHomeLayout, getHomeLayout);
}
