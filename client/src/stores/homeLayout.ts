import { useSyncExternalStore } from 'react';
import {
    homeLayoutSchema,
    type HomeFeatureId,
    type HomeLayout,
    type HomeSection,
    type HomeSectionKind,
    type HomeTopbarWidgetId,
    type ShortcutItem,
    type ShortcutTemplate
} from 'deveye-types';
import { ws } from '@/api/ws';

/**
 * Home grid layout: ordered **sections**, each holding ordered tiles of a single
 * kind. Sections are fully modular — none by default, added/removed/reordered by
 * the user, several of the same kind allowed — so a section is identified by its
 * `id`, never by its kind. Persisted in localStorage for an instant paint, and
 * synced to the server (debounced) so the arrangement follows the user across
 * devices. Mirrors {@link ./theme}.
 *
 * Holds only non-sensitive personalization metadata (feature ids, device ids,
 * pinned link objects) — never zero-knowledge payload.
 */
const KEY = 'deveye:homeLayout';

/** A fresh home: no grid section, no navbar mini-widget. */
const EMPTY_LAYOUT: HomeLayout = { topbar: [], sections: [] };

function uid(): string {
    return crypto.randomUUID();
}

function read(): HomeLayout {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return EMPTY_LAYOUT;
        const parsed = homeLayoutSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : EMPTY_LAYOUT;
    } catch {
        return EMPTY_LAYOUT;
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

// Debounced server sync: coalesce rapid edits (a drag, several adds, typing a
// section title) into one WS call.
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

/** Replace one section's tiles (matched by id), keeping the others/order intact. */
function replaceItems(sectionId: string, items: HomeSection['items']): void {
    commit({
        ...state,
        sections: state.sections.map((s) => (s.id === sectionId ? ({ ...s, items } as HomeSection) : s))
    });
}

export function getHomeLayout(): HomeLayout {
    return state;
}

export function findSection(layout: HomeLayout, sectionId: string): HomeSection | undefined {
    return layout.sections.find((s) => s.id === sectionId);
}

/**
 * Every device id on the grid, whichever section holds it. Used by the readers
 * that don't care where a tile sits: the device popup views, the prune pass, and
 * "already placed" filtering in the picker (a device belongs to one section).
 */
export function placedDeviceIds(layout: HomeLayout): string[] {
    return layout.sections.flatMap((s) => (s.kind === 'device' ? s.items : []));
}

/** Same, for feature tiles (a feature also belongs to a single section). */
export function placedFeatureIds(layout: HomeLayout): HomeFeatureId[] {
    return layout.sections.flatMap((s) => (s.kind === 'feature' ? s.items : []));
}

// ── Sections ───────────────────────────────────────────────────────────────
/** Append an empty section of `kind` and return its id (so the UI can focus it). */
export function addSection(kind: HomeSectionKind): string {
    const id = uid();
    commit({ ...state, sections: [...state.sections, { id, kind, items: [] } as HomeSection] });
    return id;
}

export function removeSection(sectionId: string): void {
    commit({ ...state, sections: state.sections.filter((s) => s.id !== sectionId) });
}

/** Blank title → drop the field entirely (back to an untitled section). */
export function renameSection(sectionId: string, title: string): void {
    const next = title.trim();
    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id !== sectionId) return s;
            const { title: _dropped, ...rest } = s;
            return (next ? { ...rest, title: next } : rest) as HomeSection;
        })
    });
}

export function setSectionOrder(ids: string[]): void {
    const byId = new Map(state.sections.map((s) => [s.id, s]));
    const reordered = ids.map((id) => byId.get(id)).filter((s): s is HomeSection => !!s);
    // Guard: keep any section not present in `ids` (shouldn't happen) at the end.
    for (const s of state.sections) if (!ids.includes(s.id)) reordered.push(s);
    commit({ ...state, sections: reordered });
}

/** Move one tile within its section (after a drag). */
export function moveSectionItem(sectionId: string, from: number, to: number): void {
    const section = findSection(state, sectionId);
    if (!section || from === to) return;
    // The item type varies per kind and a permutation can't change it, so an
    // untyped copy is safe here — and it keeps callers free of per-kind branches.
    const items = section.items.slice() as unknown[];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    replaceItems(sectionId, items as HomeSection['items']);
}

/**
 * Move one tile to another section of the same kind (a drag across sections).
 * Kinds must match — a feature tile has no meaning in a device section — and a
 * feature/device stays unique, so the move never duplicates it.
 */
export function transferSectionItem(fromId: string, toId: string, from: number, to: number): void {
    const source = findSection(state, fromId);
    const target = findSection(state, toId);
    if (!source || !target || source.id === target.id || source.kind !== target.kind) return;

    // Same reasoning as moveSectionItem: the item keeps its type, only its home
    // changes, so both lists are spliced untyped and re-typed on the way out.
    const sourceItems = source.items.slice() as unknown[];
    const [moved] = sourceItems.splice(from, 1);
    if (moved === undefined) return;
    const targetItems = target.items.slice() as unknown[];
    targetItems.splice(Math.min(Math.max(to, 0), targetItems.length), 0, moved);

    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id === fromId) return { ...s, items: sourceItems } as HomeSection;
            if (s.id === toId) return { ...s, items: targetItems } as HomeSection;
            return s;
        })
    });
}

// ── Tiles ──────────────────────────────────────────────────────────────────
export function addFeature(sectionId: string, featureId: HomeFeatureId): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'feature' || section.items.includes(featureId)) return;
    replaceItems(sectionId, [...section.items, featureId]);
}
export function removeFeature(sectionId: string, featureId: HomeFeatureId): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'feature') return;
    replaceItems(
        sectionId,
        section.items.filter((id) => id !== featureId)
    );
}

export function addDevice(sectionId: string, deviceId: string): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'device' || section.items.includes(deviceId)) return;
    replaceItems(sectionId, [...section.items, deviceId]);
}
export function removeDevice(sectionId: string, deviceId: string): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'device') return;
    replaceItems(
        sectionId,
        section.items.filter((id) => id !== deviceId)
    );
}

export interface ShortcutDraft {
    template: ShortcutTemplate;
    url: string;
    title: string;
    description?: string;
    icon?: string;
}

function shortcutFrom(id: string, draft: ShortcutDraft): ShortcutItem {
    return {
        id,
        template: draft.template,
        url: draft.url,
        title: draft.title,
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.icon ? { icon: draft.icon } : {})
    };
}

export function addShortcut(sectionId: string, draft: ShortcutDraft): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'shortcut') return;
    replaceItems(sectionId, [...section.items, shortcutFrom(uid(), draft)]);
}
export function updateShortcut(sectionId: string, id: string, draft: ShortcutDraft): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'shortcut') return;
    replaceItems(
        sectionId,
        section.items.map((s) => (s.id === id ? shortcutFrom(id, draft) : s))
    );
}
export function removeShortcut(sectionId: string, id: string): void {
    const section = findSection(state, sectionId);
    if (section?.kind !== 'shortcut') return;
    replaceItems(
        sectionId,
        section.items.filter((s) => s.id !== id)
    );
}

// ── Navbar mini-widgets ────────────────────────────────────────────────────
export function setTopbarOrder(topbar: HomeTopbarWidgetId[]): void {
    commit({ ...state, topbar });
}
export function addTopbarWidget(id: HomeTopbarWidgetId): void {
    if (state.topbar.includes(id)) return;
    commit({ ...state, topbar: [...state.topbar, id] });
}
export function removeTopbarWidget(id: HomeTopbarWidgetId): void {
    commit({ ...state, topbar: state.topbar.filter((w) => w !== id) });
}

/**
 * Drop device tiles whose device no longer exists (deleted), across every device
 * section. No-op when nothing is stale. Only call once devices have actually
 * loaded, so a transient empty list can't wipe the layout.
 */
export function pruneMissingDevices(validDeviceIds: Set<string>): void {
    let changed = false;
    const sections = state.sections.map((s) => {
        if (s.kind !== 'device') return s;
        const items = s.items.filter((id) => validDeviceIds.has(id));
        if (items.length === s.items.length) return s;
        changed = true;
        return { ...s, items };
    });
    if (changed) commit({ ...state, sections });
}

/**
 * Called by AuthProvider when a user bundle arrives. The server copy wins over
 * localStorage so the layout propagates across devices; skipped when the server
 * has none (fresh user) so the last local edit stands.
 */
export function syncHomeLayoutFromServer(serverLayout: HomeLayout | null): void {
    if (!serverLayout) return;
    state = serverLayout;
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
