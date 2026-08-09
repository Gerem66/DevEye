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
import { getActiveWorkspaceId } from './workspace';

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
const KEY_PREFIX = 'deveye:homeLayout';

/** Meme raisonnement que le theme : la disposition appartient a l'espace. */
function storageKey(): string | null {
    const id = getActiveWorkspaceId();
    return id === null ? null : `${KEY_PREFIX}:${id}`;
}

/** A fresh home: no grid section, no navbar mini-widget. */
const EMPTY_LAYOUT: HomeLayout = { topbar: [], sections: [] };

function uid(): string {
    return crypto.randomUUID();
}

function read(): HomeLayout {
    try {
        const key = storageKey();
        if (key === null) return EMPTY_LAYOUT;
        const raw = localStorage.getItem(key);
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
        const key = storageKey();
        if (key === null) return;
        localStorage.setItem(key, JSON.stringify(state));
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

/**
 * Rend une section repliable, ou cesse de l'être.
 *
 * Retirer le repli **retire aussi** l'état initial replié : une section qu'on ne
 * peut pas déplier mais qui démarre repliée serait simplement invisible, et
 * c'est le genre d'incohérence qu'il vaut mieux rendre impossible que d'avoir à
 * expliquer.
 */
export function setSectionCollapsible(sectionId: string, collapsible: boolean): void {
    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id !== sectionId) return s;
            const { collapsible: _c, collapsed: _d, ...rest } = s;
            return (collapsible ? { ...rest, collapsible: true } : rest) as HomeSection;
        })
    });
}

/** Pose l'état initial : la section s'ouvre-t-elle repliée ? */
export function setSectionCollapsed(sectionId: string, collapsed: boolean): void {
    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id !== sectionId) return s;
            const { collapsed: _dropped, ...rest } = s;
            return (collapsed ? { ...rest, collapsed: true } : rest) as HomeSection;
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

/**
 * L'identité d'une tuile, quel que soit le genre de sa section.
 *
 * Un raccourci porte son `id`, un appareil et une fonctionnalité **sont** leur
 * id. Une seule définition, ici, parce que c'est le vocabulaire du déplacement :
 * l'organiseur s'en sert pour ses identifiants de glissé, le store pour retrouver
 * une tuile. Deux copies auraient divergé au premier genre ajouté.
 */
export function sectionTileIds(section: HomeSection): string[] {
    return section.kind === 'shortcut' ? section.items.map((s) => s.id) : [...section.items];
}

/**
 * Où insérer, sachant devant quelle tuile on lâche.
 *
 * `null` = à la fin (on a lâché sur la section elle-même, pas sur une tuile).
 * Une tuile inconnue vaut la fin aussi : mieux vaut un rang inattendu qu'un
 * indice négatif qui déplacerait la mauvaise chose.
 */
function insertIndex(section: HomeSection, beforeId: string | null): number {
    if (beforeId === null) return section.items.length;
    const at = sectionTileIds(section).indexOf(beforeId);
    return at < 0 ? section.items.length : at;
}

/**
 * Déplace une tuile dans sa section.
 *
 * ## Une tuile se désigne par son identité, jamais par son rang
 *
 * Ces deux fonctions étaient appelées avec des indices lus dans l'instantané de
 * rendu de l'organiseur. Or un glissé émet des dizaines d'événements par seconde
 * quand React n'a rendu qu'une fois : l'indice décrivait alors une liste qui
 * n'existait plus, et l'on découpait **une autre tuile** — ou rien du tout, ce
 * qui insérait un `undefined` dans `items`. Une disposition portant un trou ne
 * passe plus le schéma : elle est rejetée par le serveur, et relue vide au
 * démarrage suivant. C'est-à-dire un accueil effacé, sans rien pour le dire.
 *
 * Une identité, elle, ne périme pas. Les deux bouts du déplacement — la tuile et
 * le point d'insertion — sont donc résolus **ici**, sur l'état courant, au moment
 * où l'écriture a lieu. Un appelant en retard ne peut plus au pire que demander
 * un déplacement sans objet, qui ne fait rien.
 */
export function moveSectionItem(sectionId: string, tileId: string, beforeId: string | null): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    const from = sectionTileIds(section).indexOf(tileId);
    if (from < 0) return;
    const to = insertIndex(section, beforeId);
    if (from === to) return;

    // The item type varies per kind and a permutation can't change it, so an
    // untyped copy is safe here — and it keeps callers free of per-kind branches.
    //
    // `to` est un rang de la liste **d'avant le retrait** : c'est la convention
    // d'`arrayMove`, celle que dnd-kit anime à l'écran. Le corriger du décalage
    // du retrait décalerait le résultat d'un cran par rapport à ce que le glissé
    // vient de montrer.
    const items = section.items.slice() as unknown[];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    replaceItems(sectionId, items as HomeSection['items']);
}

/**
 * Déplace une tuile vers une autre section du même genre (un glissé entre deux).
 *
 * Les genres doivent correspondre — une fonctionnalité n'a aucun sens dans une
 * section d'appareils — et la tuile est retirée avant d'être posée, donc le
 * déplacement ne peut pas la dupliquer. Mêmes garanties d'identité que
 * {@link moveSectionItem}.
 */
export function transferSectionItem(fromId: string, toId: string, tileId: string, beforeId: string | null): void {
    const source = findSection(state, fromId);
    const target = findSection(state, toId);
    if (!source || !target || source.id === target.id || source.kind !== target.kind) return;

    const from = sectionTileIds(source).indexOf(tileId);
    if (from < 0) return;
    const to = insertIndex(target, beforeId);

    // Same reasoning as moveSectionItem: the item keeps its type, only its home
    // changes, so both lists are spliced untyped and re-typed on the way out.
    const sourceItems = source.items.slice() as unknown[];
    const [moved] = sourceItems.splice(from, 1);
    const targetItems = target.items.slice() as unknown[];
    targetItems.splice(to, 0, moved);

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
    // Espace sans disposition enregistree : accueil vide, et surtout pas celui
    // de l'espace precedent.
    if (!serverLayout) {
        resetHomeLayout();
        return;
    }
    state = serverLayout;
    persist();
    for (const fn of listeners) fn();
}

/** Vide la disposition en memoire sans toucher aux cles des autres espaces. */
export function resetHomeLayout(): void {
    state = EMPTY_LAYOUT;
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function useHomeLayout(): HomeLayout {
    return useSyncExternalStore(subscribe, getHomeLayout, getHomeLayout);
}
