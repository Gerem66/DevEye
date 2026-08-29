import { useSyncExternalStore } from 'react';
import {
    homeLayoutSchema,
    homeTileId,
    homeTileKind,
    isFeatureTile,
    isHomeFolder,
    isShortcutTile,
    HOME_FOLDER_MAX_ITEMS,
    HOME_SECTION_MAX_TILES,
    type HomeFeatureId,
    type HomeFolder,
    type HomeLayout,
    type HomeSection,
    type HomeTile,
    type HomeTopbarWidgetId,
    type ShortcutItem,
    type ShortcutTemplate
} from '@deveye/types';
import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from './workspace';

/**
 * Home grid layout: ordered sections, each holding ordered tiles of any kind. A
 * section is identified by its `id`, a tile by what it is. Persisted in
 * localStorage for an instant paint and synced to the server (debounced). Holds
 * only non-sensitive personalization metadata, never zero-knowledge payload.
 */
const KEY_PREFIX = 'deveye:homeLayout';

/** Meme raisonnement que le theme : la disposition appartient a l'espace. */
function storageKey(): string | null {
    const id = getActiveWorkspaceId();
    return id === null ? null : `${KEY_PREFIX}:${id}`;
}

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

// Debounced server sync: coalesce rapid edits into one WS call.
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

function replaceItems(sectionId: string, items: HomeTile[]): void {
    commit({
        ...state,
        sections: state.sections.map((s) => (s.id === sectionId ? { ...s, items } : s))
    });
}

export function getHomeLayout(): HomeLayout {
    return state;
}

export function findSection(layout: HomeLayout, sectionId: string): HomeSection | undefined {
    return layout.sections.find((s) => s.id === sectionId);
}

function allTiles(layout: HomeLayout): HomeTile[] {
    return layout.sections.flatMap((s) => s.items);
}

/** Every device id on the grid; a device belongs to exactly one section. */
export function placedDeviceIds(layout: HomeLayout): string[] {
    return allTiles(layout)
        .filter((tile) => homeTileKind(tile) === 'device')
        .map((tile) => homeTileId(tile));
}

/**
 * Same, for feature tiles, folder contents included: a feature filed in a folder
 * counts as placed, so the "not twice" rule needs no knowledge of folders.
 */
export function placedFeatureIds(layout: HomeLayout): HomeFeatureId[] {
    return allTiles(layout).flatMap((tile) => {
        if (isHomeFolder(tile)) return tile.items;
        return isFeatureTile(tile) ? [tile] : [];
    });
}

/** Les fonctionnalités rangées dans un dossier, où qu'il soit. */
export function foldedFeatureIds(layout: HomeLayout): HomeFeatureId[] {
    return allTiles(layout).flatMap((tile) => (isHomeFolder(tile) ? tile.items : []));
}

/** Retrouve un dossier et la section qui le porte : son id est unique dans tout
 *  l'accueil. */
export function findFolder(layout: HomeLayout, folderId: string): { section: HomeSection; folder: HomeFolder } | null {
    for (const section of layout.sections) {
        for (const tile of section.items) {
            if (isHomeFolder(tile) && tile.id === folderId) return { section, folder: tile };
        }
    }
    return null;
}

// ── Sections ───────────────────────────────────────────────────────────────
/** Append an empty section and return its id, so the UI can focus it. */
export function addSection(): string {
    const id = uid();
    commit({ ...state, sections: [...state.sections, { id, items: [] }] });
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
            return next ? { ...rest, title: next } : rest;
        })
    });
}

/**
 * Retirer le repli retire aussi l'état initial replié : une section qu'on ne peut
 * pas déplier mais qui démarre repliée serait invisible.
 */
export function setSectionCollapsible(sectionId: string, collapsible: boolean): void {
    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id !== sectionId) return s;
            const { collapsible: _c, collapsed: _d, ...rest } = s;
            return collapsible ? { ...rest, collapsible: true } : rest;
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
            return collapsed ? { ...rest, collapsed: true } : rest;
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

export function sectionTileIds(section: HomeSection): string[] {
    return section.items.map((tile) => homeTileId(tile));
}

/**
 * Où insérer, sachant devant quelle tuile on lâche. `null` = à la fin, et une
 * tuile inconnue aussi : mieux vaut un rang inattendu qu'un indice négatif qui
 * déplacerait la mauvaise chose.
 */
function insertIndex(section: HomeSection, beforeId: string | null): number {
    if (beforeId === null) return section.items.length;
    const at = sectionTileIds(section).indexOf(beforeId);
    return at < 0 ? section.items.length : at;
}

/**
 * Déplace une tuile dans sa section. Elle se désigne par son identité, jamais par
 * son rang : un glissé émet des dizaines d'événements par seconde là où React n'a
 * rendu qu'une fois, et un indice lu dans l'instantané de rendu décrirait une
 * liste qui n'existe plus. Les deux bouts sont résolus ici, sur l'état courant.
 */
export function moveSectionItem(sectionId: string, tileId: string, beforeId: string | null): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    const from = sectionTileIds(section).indexOf(tileId);
    if (from < 0) return;
    const to = insertIndex(section, beforeId);
    if (from === to) return;

    // `to` est un rang de la liste d'avant le retrait (convention d'`arrayMove`,
    // celle que dnd-kit anime à l'écran).
    const items = section.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    replaceItems(sectionId, items);
}

/**
 * Déplace une tuile vers une autre section. Elle est retirée avant d'être posée,
 * donc le déplacement ne peut pas la dupliquer. Mêmes garanties d'identité que
 * {@link moveSectionItem}.
 */
export function transferSectionItem(fromId: string, toId: string, tileId: string, beforeId: string | null): void {
    const source = findSection(state, fromId);
    const target = findSection(state, toId);
    if (!source || !target || source.id === target.id) return;

    const from = sectionTileIds(source).indexOf(tileId);
    if (from < 0) return;
    const to = insertIndex(target, beforeId);

    const sourceItems = source.items.slice();
    const [moved] = sourceItems.splice(from, 1);
    const targetItems = target.items.slice();
    targetItems.splice(to, 0, moved);

    commit({
        ...state,
        sections: state.sections.map((s) => {
            if (s.id === fromId) return { ...s, items: sourceItems };
            if (s.id === toId) return { ...s, items: targetItems };
            return s;
        })
    });
}

// ── Tiles ──────────────────────────────────────────────────────────────────
/**
 * Pose une tuile en fin de section. Le plafond du schéma est tenu avant
 * l'écriture : une section trop longue ne se valide plus, le serveur la refuse et
 * le prochain démarrage relit une disposition vide.
 */
function appendTile(sectionId: string, tile: HomeTile): boolean {
    const section = findSection(state, sectionId);
    if (!section || section.items.length >= HOME_SECTION_MAX_TILES) return false;
    replaceItems(sectionId, [...section.items, tile]);
    return true;
}

/** Retire une tuile de sa section, sans confirmation : c'est l'appelant qui décide. */
export function removeTile(sectionId: string, tileId: string): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    const items = section.items.filter((tile) => homeTileId(tile) !== tileId);
    if (items.length !== section.items.length) replaceItems(sectionId, items);
}

/** Refusée si la fonctionnalité est déjà quelque part sur l'accueil, dossiers compris. */
export function addFeature(sectionId: string, featureId: HomeFeatureId): void {
    if (placedFeatureIds(state).includes(featureId)) return;
    appendTile(sectionId, featureId);
}

/** Même garde pour un appareil : une machine n'a qu'une carte sur l'accueil. */
export function addDevice(sectionId: string, deviceId: string): void {
    if (placedDeviceIds(state).includes(deviceId)) return;
    appendTile(sectionId, deviceId);
}

// ── Dossiers ───────────────────────────────────────────────────────────────
/** Réécrit un dossier en place, où qu'il soit : son id est unique. */
function updateFolder(folderId: string, fn: (folder: HomeFolder) => HomeFolder): void {
    let touched = false;
    const sections = state.sections.map((section) => ({
        ...section,
        items: section.items.map((tile) => {
            if (!isHomeFolder(tile) || tile.id !== folderId) return tile;
            touched = true;
            return fn(tile);
        })
    }));
    if (touched) commit({ ...state, sections });
}

/** Ajoute un dossier vide en fin de section et rend son id (`null` si la section est pleine). */
export function addFolder(sectionId: string): string | null {
    const id = uid();
    return appendTile(sectionId, { kind: 'folder', id, title: '', items: [] }) ? id : null;
}

/** Intitulé porté par la carte. Vide, l'affichage retombe sur « Dossier ». */
export function renameFolder(folderId: string, title: string): void {
    updateFolder(folderId, (folder) => ({ ...folder, title: title.slice(0, 40) }));
}

function folderInsertIndex(folder: HomeFolder, beforeId: string | null): number {
    if (beforeId === null) return folder.items.length;
    const at = folder.items.indexOf(beforeId as HomeFeatureId);
    return at < 0 ? folder.items.length : at;
}

/**
 * Range une fonctionnalité dans un dossier, d'où qu'elle vienne. Elle quitte sa
 * tuile de grille ou son autre dossier dans la même écriture, deux mutations
 * ayant envoyé au serveur une disposition portant le doublon.
 */
export function fileInFolder(folderId: string, featureId: HomeFeatureId, beforeId: string | null): void {
    // Le plafond du schéma, tenu avant l'écriture. Une fonctionnalité déjà rangée
    // ici ne fait que changer de rang.
    const target = findFolder(state, folderId)?.folder;
    if (!target) return;
    if (!target.items.includes(featureId) && target.items.length >= HOME_FOLDER_MAX_ITEMS) return;

    let filed = false;
    const sections = state.sections.map((section) => {
        const items = section.items.flatMap<HomeTile>((tile) => {
            // La tuile de la grille, s'il y en avait une : elle s'en va.
            if (!isHomeFolder(tile)) return tile === featureId ? [] : [tile];
            if (tile.id !== folderId) {
                // Un autre dossier qui la tenait : elle en sort.
                const rest = tile.items.filter((id) => id !== featureId);
                return [rest.length === tile.items.length ? tile : { ...tile, items: rest }];
            }
            filed = true;
            const items = tile.items.filter((id) => id !== featureId);
            items.splice(folderInsertIndex({ ...tile, items }, beforeId), 0, featureId);
            return [{ ...tile, items }];
        });
        return { ...section, items };
    });
    // Sans dossier cible, rien : retirer la tuile de la grille pour la ranger
    // nulle part serait une disparition.
    if (filed) commit({ ...state, sections });
}

/** Réordonne une fonctionnalité dans son dossier, sans l'en sortir. */
export function moveFolderItem(folderId: string, featureId: HomeFeatureId, beforeId: string | null): void {
    updateFolder(folderId, (folder) => {
        const from = folder.items.indexOf(featureId);
        if (from < 0) return folder;
        const to = folderInsertIndex(folder, beforeId);
        if (from === to) return folder;
        const items = folder.items.slice();
        const [moved] = items.splice(from, 1);
        // `to` est un rang d'avant le retrait, convention d'`arrayMove`.
        items.splice(to, 0, moved);
        return { ...folder, items };
    });
}

/**
 * Sort une fonctionnalité de son dossier et la repose sur la grille, en une seule
 * écriture pour la même raison que {@link fileInFolder}.
 */
export function unfileFromFolder(
    folderId: string,
    featureId: HomeFeatureId,
    sectionId: string,
    beforeId: string | null
): void {
    const target = findSection(state, sectionId);
    if (!target || target.items.length >= HOME_SECTION_MAX_TILES) return;
    let freed = false;
    const sections = state.sections.map((section) => {
        let items = section.items.map((tile) => {
            if (!isHomeFolder(tile) || tile.id !== folderId) return tile;
            const rest = tile.items.filter((id) => id !== featureId);
            if (rest.length !== tile.items.length) freed = true;
            return { ...tile, items: rest };
        });
        if (section.id === sectionId) {
            items = items.slice();
            items.splice(insertIndex({ ...section, items }, beforeId), 0, featureId);
        }
        return { ...section, items };
    });
    // Le dossier ne la tenait pas : la poser sur la grille l'aurait dupliquée.
    if (freed) commit({ ...state, sections });
}

/** Retire une fonctionnalité du dossier et de l'accueil : elle redevient
 *  proposable au marché. */
export function removeFolderItem(folderId: string, featureId: HomeFeatureId): void {
    updateFolder(folderId, (folder) => ({
        ...folder,
        items: folder.items.filter((id) => id !== featureId)
    }));
}

// ── Raccourcis ─────────────────────────────────────────────────────────────
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
    appendTile(sectionId, shortcutFrom(uid(), draft));
}

export function updateShortcut(sectionId: string, id: string, draft: ShortcutDraft): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    // Les identifiants de toutes les tuiles vivent dans le même espace de noms :
    // sans la garde de genre, un appelant trompé de cible remplacerait une carte
    // d'appareil par un raccourci.
    replaceItems(
        sectionId,
        section.items.map((tile) => (isShortcutTile(tile) && tile.id === id ? shortcutFrom(id, draft) : tile))
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
 * Drop device tiles whose device no longer exists, across every section. Only
 * call once devices have actually loaded, so a transient empty list can't wipe
 * the layout.
 */
export function pruneMissingDevices(validDeviceIds: Set<string>): void {
    let changed = false;
    const sections = state.sections.map((s) => {
        const items = s.items.filter((tile) => homeTileKind(tile) !== 'device' || validDeviceIds.has(tile as string));
        if (items.length === s.items.length) return s;
        changed = true;
        return { ...s, items };
    });
    if (changed) commit({ ...state, sections });
}

/**
 * The server copy wins over localStorage so the layout propagates across devices;
 * skipped when the server has none, so the last local edit stands.
 */
export function syncHomeLayoutFromServer(serverLayout: HomeLayout | null): void {
    // Espace sans disposition enregistree : accueil vide, pas celui de l'espace precedent.
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
