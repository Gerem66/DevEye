import { useSyncExternalStore } from 'react';
import {
    homeLayoutSchema,
    homeTileId,
    homeTileKind,
    isFeatureTile,
    isHomeFolder,
    isShortcutTile,
    HOME_SECTION_MAX_TILES,
    type HomeFeatureId,
    type HomeFolder,
    type HomeLayout,
    type HomeSection,
    type HomeTile,
    type HomeTopbarWidgetId,
    type ShortcutItem,
    type ShortcutTemplate
} from 'deveye-types';
import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from './workspace';

/**
 * Home grid layout: ordered **sections**, each holding ordered tiles. Sections
 * are fully modular — none by default, added/removed/reordered by the user —
 * and, since the unification, **untyped**: appareils, fonctionnalités,
 * raccourcis et dossiers cohabitent dans la même. Une section est donc
 * identifiée par son `id`, et une tuile par ce qu'elle est.
 * Persisted in localStorage for an instant paint, and synced to the server
 * (debounced) so the arrangement follows the user across devices. Mirrors
 * {@link ./theme}.
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

/** Toutes les tuiles posées sur l'accueil, sections confondues. */
function allTiles(layout: HomeLayout): HomeTile[] {
    return layout.sections.flatMap((s) => s.items);
}

/**
 * Every device id on the grid, whichever section holds it. Used by the readers
 * that don't care where a tile sits: the device popup views, the prune pass, and
 * "already placed" filtering in the picker (a device belongs to one section).
 */
export function placedDeviceIds(layout: HomeLayout): string[] {
    return allTiles(layout)
        .filter((tile) => homeTileKind(tile) === 'device')
        .map((tile) => homeTileId(tile));
}

/**
 * Same, for feature tiles (a feature also belongs to a single section).
 *
 * **Le contenu des dossiers en fait partie.** Une fonctionnalité rangée dans un
 * dossier est posée sur l'accueil comme une autre : simplement, sa carte attend
 * derrière une tuile au lieu d'occuper une place. Tout ce qui se demande « où
 * est-elle ? » lit cette liste, donc la règle « pas deux fois la même » et la
 * survie d'une vue ouverte à une bascule d'espace n'ont pas à connaître les
 * dossiers.
 */
export function placedFeatureIds(layout: HomeLayout): HomeFeatureId[] {
    return allTiles(layout).flatMap((tile) => {
        if (isHomeFolder(tile)) return tile.items;
        return isFeatureTile(tile) ? [tile] : [];
    });
}

/**
 * Les fonctionnalités **rangées dans un dossier**, où qu'il soit.
 *
 * Le complément de `placedFeatureIds` : ce qui est posé sur l'accueil sans être
 * là-dedans se trouve sur la grille, et peut donc être déplacé dans un dossier.
 */
export function foldedFeatureIds(layout: HomeLayout): HomeFeatureId[] {
    return allTiles(layout).flatMap((tile) => (isHomeFolder(tile) ? tile.items : []));
}

/**
 * Retrouve un dossier dans la disposition, et la section qui le porte.
 *
 * Par son seul id : un dossier est unique dans tout l'accueil, et ses appelants
 * (l'écran qui le déploie, la fiche qui l'édite) n'ont aucune raison de tenir la
 * section à jour de leur côté. Relire par id à chaque rendu est aussi ce qui
 * fait que l'écran suit une modification venue d'un autre membre de l'espace.
 */
export function findFolder(layout: HomeLayout, folderId: string): { section: HomeSection; folder: HomeFolder } | null {
    for (const section of layout.sections) {
        for (const tile of section.items) {
            if (isHomeFolder(tile) && tile.id === folderId) return { section, folder: tile };
        }
    }
    return null;
}

// ── Sections ───────────────────────────────────────────────────────────────
/**
 * Append an empty section and return its id (so the UI can focus it).
 *
 * Plus rien à choisir avant : une section ne se distingue plus par ce qu'elle
 * tient, donc le bouton l'ajoute sur-le-champ au lieu d'ouvrir une popup pour
 * une question qui n'existe plus.
 */
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

/**
 * L'identité des tuiles d'une section, dans l'ordre.
 *
 * C'est le vocabulaire du déplacement : l'organiseur s'en sert pour ses
 * identifiants de glissé, le store pour retrouver une tuile. La forme de
 * l'union, elle, n'est lue que par `homeTileId` (voir `deveye-types`).
 */
export function sectionTileIds(section: HomeSection): string[] {
    return section.items.map((tile) => homeTileId(tile));
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

    // `to` est un rang de la liste **d'avant le retrait** : c'est la convention
    // d'`arrayMove`, celle que dnd-kit anime à l'écran. Le corriger du décalage
    // du retrait décalerait le résultat d'un cran par rapport à ce que le glissé
    // vient de montrer.
    const items = section.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    replaceItems(sectionId, items);
}

/**
 * Déplace une tuile vers une autre section (un glissé entre deux).
 *
 * Plus aucune condition de genre : les sections tiennent toutes n'importe quelle
 * tuile depuis l'unification, donc tout va partout. La tuile est retirée avant
 * d'être posée, donc le déplacement ne peut pas la dupliquer. Mêmes garanties
 * d'identité que {@link moveSectionItem}.
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
 * Pose une tuile en fin de section.
 *
 * Le passage unique de tous les ajouts : le plafond du schéma est tenu **avant**
 * l'écriture (une section trop longue ne se valide plus, donc le serveur la
 * refuse et le prochain démarrage relit une disposition vide — un accueil effacé
 * en silence), et l'appelant n'a qu'à décrire ce qu'il pose.
 */
function appendTile(sectionId: string, tile: HomeTile): boolean {
    const section = findSection(state, sectionId);
    if (!section || section.items.length >= HOME_SECTION_MAX_TILES) return false;
    replaceItems(sectionId, [...section.items, tile]);
    return true;
}

/**
 * Retire une tuile de sa section, quel que soit son genre.
 *
 * Une seule fonction pour les quatre : la tuile se désigne par son identité, et
 * la retirer ne demande rien de plus. C'est l'appelant qui décide s'il faut
 * demander confirmation avant (voir l'organiseur, pour un dossier plein).
 */
export function removeTile(sectionId: string, tileId: string): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    const items = section.items.filter((tile) => homeTileId(tile) !== tileId);
    if (items.length !== section.items.length) replaceItems(sectionId, items);
}

/**
 * Pose une fonctionnalité sur la grille.
 *
 * Refusée si elle est **déjà quelque part** sur l'accueil, dossiers compris : la
 * garde est celle de la disposition entière, pas celle de la section. Le
 * sélecteur filtre déjà sur la même liste ; l'avoir aussi ici est ce qui rend la
 * règle vraie quel que soit le chemin.
 */
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
/**
 * Réécrit un dossier en place, en laissant tout le reste de la disposition
 * intact. Passage unique des mutations ci-dessous : la forme de l'union
 * (chaîne ou objet) n'est lue qu'ici.
 */
function updateFolder(sectionId: string, folderId: string, fn: (folder: HomeFolder) => HomeFolder): void {
    const section = findSection(state, sectionId);
    if (!section) return;
    let touched = false;
    const items = section.items.map((tile) => {
        if (!isHomeFolder(tile) || tile.id !== folderId) return tile;
        touched = true;
        return fn(tile);
    });
    if (touched) replaceItems(sectionId, items);
}

/**
 * Ajoute un dossier vide en fin de section et rend son id, pour que
 * l'organiseur ouvre sa fiche dans la foulée : un dossier vide n'a rien à
 * montrer, le remplir est le geste suivant.
 */
export function addFolder(sectionId: string): string | null {
    const id = uid();
    return appendTile(sectionId, { kind: 'folder', id, title: '', items: [] }) ? id : null;
}

/** Intitulé porté par la carte. Vide, l'affichage retombe sur « Dossier ». */
export function renameFolder(sectionId: string, folderId: string, title: string): void {
    updateFolder(sectionId, folderId, (folder) => ({ ...folder, title: title.slice(0, 40) }));
}

/**
 * Range une fonctionnalité dans un dossier, d'où qu'elle vienne.
 *
 * Posée sur la grille, elle **quitte sa tuile dans la même écriture** : deux
 * mutations l'auraient laissée à deux endroits le temps d'un rendu, et surtout
 * la disposition partie au serveur entre les deux aurait porté le doublon. Ce
 * qui est déjà dans un **autre** dossier ne bouge pas : la fiche ne le propose
 * pas, et une demande venue d'ailleurs ne doit pas vider un dossier voisin sans
 * que personne l'ait demandé.
 */
export function addFeatureToFolder(sectionId: string, folderId: string, featureId: HomeFeatureId): void {
    if (foldedFeatureIds(state).includes(featureId)) return;
    let filed = false;
    const sections = state.sections.map((section) => {
        const items = section.items.flatMap<HomeTile>((tile) => {
            // La tuile de la grille, s'il y en avait une : elle s'en va.
            if (!isHomeFolder(tile)) return tile === featureId ? [] : [tile];
            if (section.id !== sectionId || tile.id !== folderId) return [tile];
            filed = true;
            return [{ ...tile, items: [...tile.items, featureId] }];
        });
        return { ...section, items };
    });
    // Sans dossier cible, rien : retirer la tuile de la grille pour la ranger
    // nulle part serait une disparition pure et simple.
    if (filed) commit({ ...state, sections });
}

/**
 * Sort une fonctionnalité de son dossier. Elle quitte l'accueil et redevient
 * proposable dans le sélecteur : la remettre sur la grille est un ajout normal,
 * ce qui évite un troisième geste (« sortir vers la section ») à comprendre.
 */
export function removeFeatureFromFolder(sectionId: string, folderId: string, featureId: HomeFeatureId): void {
    updateFolder(sectionId, folderId, (folder) => ({
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
    // La garde de genre n'est pas décorative : les identifiants de toutes les
    // tuiles vivent désormais dans le même espace de noms, et écrire sans elle
    // remplacerait une carte d'appareil par un raccourci si l'appelant se
    // trompait de cible.
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
 * Drop device tiles whose device no longer exists (deleted), across every
 * section. No-op when nothing is stale. Only call once devices have actually
 * loaded, so a transient empty list can't wipe the layout.
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
