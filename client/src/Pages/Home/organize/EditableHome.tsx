import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    DndContext,
    DragOverlay,
    closestCenter,
    KeyboardSensor,
    MeasuringStrategy,
    PointerSensor,
    pointerWithin,
    useDroppable,
    useSensor,
    useSensors,
    type CollisionDetection,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    rectSortingStrategy,
    verticalListSortingStrategy,
    type SortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Device, HomeFeatureId, HomeFolder, HomeSection, HomeTile, ShortcutItem } from '@deveye/types';
import { homeTileId, isFeatureTile, isHomeFolder, isShortcutTile } from '@deveye/types';

import { useDevices } from '@/stores/devices';
import {
    addFolder,
    addSection,
    fileInFolder,
    foldedFeatureIds,
    getHomeLayout,
    moveFolderItem,
    moveSectionItem,
    placedFeatureIds,
    removeFolderItem,
    removeSection,
    removeTile,
    renameFolder,
    renameSection,
    setSectionCollapsed,
    setSectionCollapsible,
    sectionTileIds,
    setSectionOrder,
    transferSectionItem,
    unfileFromFolder,
    useHomeLayout
} from '@/stores/homeLayout';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import { Widget } from '@/Components/Widget';
import { featureTileVisual, homeTileVisual, type TileVisual } from '../tiles/tileVisual';
import { AddTileMarket } from './AddTileMarket';
import styles from './organize.module.css';

/** A shortcut being edited, with the section it belongs to. */
interface ShortcutEdit {
    sectionId: string;
    item: ShortcutItem;
}

/** Un dossier dont on demande le retrait, avec la section qui le porte. */
interface FolderRemoval {
    sectionId: string;
    folder: HomeFolder;
}

/**
 * Les deux identifiants de glissé que porte un dossier, et pourquoi il en faut
 * deux.
 *
 * - `into:` est la **cible d'ajout** : une zone en retrait à l'intérieur de la
 *   carte fermée. La viser range la carte tirée dans le dossier ; viser les
 *   bords de la tuile continue de l'insérer avant ou après, comme n'importe
 *   quelle voisine. Un seul identifiant pour les deux gestes aurait rendu
 *   « ranger dedans » et « poser à côté » indiscernables.
 * - `zone:` est le **contenant ouvert** : la rangée dépliée sous la section,
 *   traitée comme une section de plus par tout le mécanisme de glissé. C'est ce
 *   qui fait qu'en sortir se fait exactement comme on change de section.
 */
const FOLDER_ZONE_PREFIX = 'zone:';
const FOLDER_DROP_PREFIX = 'into:';
const folderZoneId = (folderId: string) => `${FOLDER_ZONE_PREFIX}${folderId}`;
const folderDropId = (folderId: string) => `${FOLDER_DROP_PREFIX}${folderId}`;

/**
 * Un contenant de tuiles pour le glissé : une section, ou le dossier déplié.
 *
 * Les deux se comportent pareil — on y entre, on y réordonne, on en sort — donc
 * le mécanisme ne les distingue qu'au moment d'écrire. C'est ce qui évite un
 * second système de glissé rien que pour les dossiers.
 */
type DropZone =
    | { kind: 'section'; id: string; tileIds: string[]; section: HomeSection }
    | { kind: 'folder'; id: string; tileIds: string[]; folder: HomeFolder; sectionId: string };

function buildZones(sections: HomeSection[], openFolderId: string | null): DropZone[] {
    const zones: DropZone[] = sections.map((section) => ({
        kind: 'section',
        id: section.id,
        section,
        tileIds: sectionTileIds(section)
    }));
    if (openFolderId === null) return zones;
    for (const section of sections) {
        for (const tile of section.items) {
            if (!isHomeFolder(tile) || tile.id !== openFolderId) continue;
            zones.push({
                kind: 'folder',
                id: folderZoneId(tile.id),
                folder: tile,
                sectionId: section.id,
                tileIds: [...tile.items]
            });
        }
    }
    return zones;
}

/**
 * The usual grid sorting, but inert for a zone the drag has nothing to do with
 * — the one the tile just left. `overIndex` is -1 there, which the default
 * strategy reads as a move and would answer by shuffling that zone's own tiles
 * for nothing.
 */
const sortInZone: SortingStrategy = (args) => (args.overIndex < 0 ? null : rectSortingStrategy(args));

/**
 * Où se trouve une tuile.
 *
 * Rend le **contenant**, jamais un rang : un indice lu ici décrit la disposition
 * telle qu'elle était au dernier rendu, or un glissé émet bien plus d'événements
 * que React ne rend. C'est le store qui résout les positions, sur l'état courant,
 * au moment où il écrit (voir `moveSectionItem`).
 */
function zoneOf(zones: DropZone[], tileId: string): DropZone | null {
    return zones.find((z) => z.tileIds.includes(tileId)) ?? null;
}

/**
 * Ce qu'un identifiant survolé désigne : un contenant, et la tuile devant
 * laquelle insérer (`null` = à la fin, on est sur le bloc lui-même).
 */
function resolveDropTarget(zones: DropZone[], overId: string): { zone: DropZone; beforeId: string | null } | null {
    const zone = zones.find((z) => z.id === overId);
    // Dropped on the block itself (e.g. an empty section) → append at the end.
    if (zone) return { zone, beforeId: null };
    const owner = zoneOf(zones, overId);
    return owner ? { zone: owner, beforeId: overId } : null;
}

/**
 * Écrit un déplacement d'un contenant vers un autre.
 *
 * Le seul endroit qui sache que les dossiers ne prennent que des
 * fonctionnalités : une carte d'appareil ou un raccourci tiré sur un dossier ne
 * fait rien, et reste donc visiblement à sa place au lieu de disparaître.
 */
function transferBetween(from: DropZone, to: DropZone, tileId: string, beforeId: string | null): void {
    if (to.kind === 'folder') {
        if (isFeatureTile(tileId)) fileInFolder(to.folder.id, tileId, beforeId);
        return;
    }
    if (from.kind === 'folder') {
        if (isFeatureTile(tileId)) unfileFromFolder(from.folder.id, tileId, to.id, beforeId);
        return;
    }
    transferSectionItem(from.id, to.id, tileId, beforeId);
}

/** Le même, pour un déplacement **dans** un contenant. */
function moveWithin(zone: DropZone, tileId: string, beforeId: string | null): void {
    if (zone.kind === 'section') moveSectionItem(zone.id, tileId, beforeId);
    else if (isFeatureTile(tileId)) moveFolderItem(zone.folder.id, tileId, beforeId);
}

/** La tuile de cette section portant cet identifiant, s'il y en a une. */
function tileIn(section: HomeSection, id: string): HomeTile | undefined {
    return section.items.find((tile) => homeTileId(tile) === id);
}

/** Wording of the "remove a populated section" confirmation. */
function removalWarning(section: HomeSection): string {
    const n = section.items.length;
    const tiles = `${n} tuile${n > 1 ? 's' : ''}`;
    const subject = section.title ? `« ${section.title} »` : 'Cette section';
    return `${subject} et ses ${tiles} seront retirées de l’accueil.`;
}

/** Le même avertissement pour un dossier : ce qu'il tient quitte l'accueil avec lui. */
function folderRemovalWarning(folder: HomeFolder): string {
    const n = folder.items.length;
    const features = `${n} fonctionnalité${n > 1 ? 's' : ''}`;
    const subject = folder.title.trim() ? `« ${folder.title.trim()} »` : 'Ce dossier';
    return `${subject} et les ${features} qu’il contient seront retirés de l’accueil.`;
}

/** The card on its own, no drag wiring — rendered both in the grid and, while
 *  dragging, inside the DragOverlay, so the floating copy is identical. */
function TileCard({ visual }: { visual: TileVisual | null }) {
    if (!visual) {
        return <div className={`${styles.missingTile} ${styles.missingCompact}`}>Indisponible</div>;
    }
    return (
        <Widget
            widgetId={visual.widgetId}
            title={visual.title}
            icon={visual.icon}
            compact={visual.compact}
            interactive={false}
        >
            {visual.body}
        </Widget>
    );
}

/**
 * La cible « ranger dedans » d'une carte de dossier.
 *
 * En retrait dans la carte, pour que ses bords restent des points d'insertion
 * ordinaires. Décorative au clic (`pointer-events: none`) : dnd-kit compare des
 * coordonnées à un rectangle mesuré, il n'a pas besoin que l'élément reçoive
 * quoi que ce soit, et l'ouverture du dossier reste un clic sur la carte.
 */
function FolderDropTarget({ folderId }: { folderId: string }) {
    const { setNodeRef, isOver } = useDroppable({ id: folderDropId(folderId) });
    return (
        <span
            ref={setNodeRef}
            aria-hidden='true'
            className={`${styles.folderDrop} ${isOver ? styles.folderDropOver : ''}`}
        />
    );
}

/** One draggable tile inside a zone. The whole card is the drag handle; the
 *  corner × removes it (no confirmation — re-adding is trivial). While it is
 *  being dragged the card itself rides in the overlay, so what stays here is just
 *  the hole it will drop into. */
function SortableTile({
    id,
    visual,
    folderId,
    onOpen,
    onEdit,
    onRemove
}: {
    id: string;
    visual: TileVisual | null;
    /** Cette tuile est un dossier : elle accepte qu'on lui dépose des cartes. */
    folderId?: string;
    /** Cliquer la carte la déplie (dossiers). */
    onOpen?: () => void;
    /** When set, shows a pencil button (e.g. to edit a shortcut). */
    onEdit?: () => void;
    onRemove: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition
    };
    /**
     * D'où le doigt est parti, pour distinguer un clic d'un glissé.
     *
     * Le navigateur émet un `click` au relâchement **même quand le pointeur a
     * parcouru la moitié de l'écran** : sans cette mesure, lâcher une carte de
     * dossier après l'avoir déplacée l'ouvrirait dans la foulée. Le seuil est
     * celui du capteur (8 px), pour que les deux gestes se séparent exactement
     * là où dnd-kit les sépare.
     */
    const pressAt = useRef<{ x: number; y: number } | null>(null);
    const startPress = (e: React.PointerEvent) => {
        pressAt.current = { x: e.clientX, y: e.clientY };
        // Reposé **après** le spread des écouteurs de dnd-kit, cet attribut les
        // masquerait : on rappelle donc le sien à la main.
        listeners?.onPointerDown?.(e);
    };
    const handleClick = (e: React.MouseEvent) => {
        const from = pressAt.current;
        pressAt.current = null;
        if (!onOpen) return;
        if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) return;
        onOpen();
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${styles.sortTile} ${isDragging ? styles.dragging : ''} ${onOpen ? styles.openable : ''}`}
            {...attributes}
            {...listeners}
            onPointerDown={startPress}
            // Ouvrir un dossier est un clic sur sa carte, comme sur un téléphone.
            onClick={onOpen ? handleClick : undefined}
        >
            <TileCard visual={visual} />
            {folderId !== undefined && <FolderDropTarget folderId={folderId} />}
            <div className={styles.tileActions}>
                {onEdit && (
                    <button
                        className={styles.tileAction}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                        title='Modifier'
                        aria-label='Modifier la tuile'
                    >
                        <span className={`icon icon-edit ${styles.actionIconEdit}`} />
                    </button>
                )}
                <button
                    className={`${styles.tileAction} ${styles.tileRemove}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    title='Retirer'
                    aria-label='Retirer la tuile'
                >
                    <span className={`icon icon-x ${styles.actionIconRemove}`} />
                </button>
            </div>
        </div>
    );
}

/**
 * Le dossier déplié, sous la section qui le porte.
 *
 * C'est un contenant de glissé comme une section : on y tire une carte pour la
 * ranger, on en tire une dehors pour la reposer sur l'accueil. Il n'y a donc
 * plus de fiche à ouvrir pour remplir ou vider un dossier — le geste est celui
 * de l'écran d'accueil d'un téléphone, et il se fait à l'endroit même où l'on
 * voit le résultat.
 */
function FolderPanel({ folder, onClose }: { folder: HomeFolder; onClose: () => void }) {
    const { setNodeRef, isOver } = useDroppable({ id: folderZoneId(folder.id) });
    return (
        <div className={styles.folderPanel}>
            <div className={styles.folderPanelHead}>
                <span className={`icon icon-folder ${styles.folderPanelIcon}`} aria-hidden='true' />
                <input
                    className={styles.sectionTitleInput}
                    value={folder.title}
                    onChange={(e) => renameFolder(folder.id, e.target.value)}
                    placeholder='Nom du dossier'
                    maxLength={40}
                    aria-label='Nom du dossier'
                />
                <span className={styles.sectionCount}>{folder.items.length}</span>
                <button
                    className={`${styles.tileAction} ${styles.sectionRemove}`}
                    onClick={onClose}
                    title='Refermer le dossier'
                    aria-label='Refermer le dossier'
                >
                    <span className={`icon icon-collapse ${styles.actionIconRemove}`} />
                </button>
            </div>
            <SortableContext items={folder.items} strategy={sortInZone}>
                <div ref={setNodeRef} className={`${styles.folderGrid} ${isOver ? styles.folderGridOver : ''}`}>
                    {folder.items.map((id) => (
                        <SortableTile
                            key={id}
                            id={id}
                            visual={featureTileVisual(id)}
                            onRemove={() => removeFolderItem(folder.id, id)}
                        />
                    ))}
                </div>
            </SortableContext>
            <p className={styles.folderHint}>
                Glissez une carte ici pour la ranger, ou tirez-en une dehors pour la remettre sur l’accueil. La croix,
                elle, la retire de l’accueil.
            </p>
        </div>
    );
}

/** The sortable grid of one section's tiles + its trailing "add" button. Its
 *  SortableContext shares the page-level DndContext, so a tile can be dragged out
 *  into any other section — or into an open folder. */
function SectionTiles({
    section,
    devices,
    onAdd,
    onAddFolder,
    onOpenFolder,
    onEditShortcut,
    onRemoveFolder
}: {
    section: HomeSection;
    devices: Device[];
    onAdd: () => void;
    onAddFolder: () => void;
    onOpenFolder: (folder: HomeFolder) => void;
    onEditShortcut: (item: ShortcutItem) => void;
    onRemoveFolder: (folder: HomeFolder) => void;
}) {
    const ids = useMemo<string[]>(() => sectionTileIds(section), [section]);

    const renderTile = (id: string) => {
        const tile = tileIn(section, id);
        const visual = tile === undefined ? null : homeTileVisual(tile, devices, { editing: true });
        const folder = tile !== undefined && isHomeFolder(tile) ? tile : null;
        // Un dossier plein prévient avant de partir ; tout le reste s'en va d'un
        // clic, parce que le reposer en est un aussi.
        const onRemove = folder ? () => onRemoveFolder(folder) : () => removeTile(section.id, id);
        return (
            <SortableTile
                key={id}
                id={id}
                visual={visual}
                folderId={folder?.id}
                onOpen={folder ? () => onOpenFolder(folder) : undefined}
                onEdit={tile !== undefined && isShortcutTile(tile) ? () => onEditShortcut(tile) : undefined}
                onRemove={onRemove}
            />
        );
    };

    return (
        <SortableContext items={ids} strategy={sortInZone}>
            <div className={styles.tileGrid}>
                {ids.map(renderTile)}
                {/*
                 * Deux boutons dans l'emprise d'une seule carte pleine hauteur.
                 *
                 * Le premier ouvre le marché, qui range appareils, fonctionnalités
                 * et raccourcis par rayons. Le second pose un dossier, et il est
                 * **ici** plutôt qu'au marché : un dossier ne se remplit qu'en y
                 * tirant des cartes déjà posées, donc il n'a de sens qu'à côté
                 * d'elles. Empilés, ils occupent la place d'une carte au lieu de
                 * laisser un demi-vide au bout de la rangée.
                 */}
                <div className={styles.addStack}>
                    <button type='button' className={styles.addTile} onClick={onAdd}>
                        <span className={`icon icon-plus ${styles.addTileIcon}`} />
                        <span className={styles.addTileLabel}>Ajouter une fonctionnalité</span>
                    </button>
                    <button type='button' className={styles.addTile} onClick={onAddFolder}>
                        <span className={`icon icon-folder-plus ${styles.addTileIcon}`} />
                        <span className={styles.addTileLabel}>Ajouter un dossier</span>
                    </button>
                </div>
            </div>
        </SortableContext>
    );
}

/** A section block: a header (drag handle, optional title, count, remove), its
 *  tile grid, and — when one of its folders is open — that folder's panel. */
function SortableSection({
    section,
    devices,
    openFolder,
    onAdd,
    onAddFolder,
    onOpenFolder,
    onCloseFolder,
    onEditShortcut,
    onRemoveFolder,
    onRemove
}: {
    section: HomeSection;
    devices: Device[];
    /** Le dossier déplié, quand il appartient à cette section. */
    openFolder: HomeFolder | null;
    onAdd: () => void;
    onAddFolder: () => void;
    onOpenFolder: (folder: HomeFolder) => void;
    onCloseFolder: () => void;
    onEditShortcut: (item: ShortcutItem) => void;
    onRemoveFolder: (folder: HomeFolder) => void;
    onRemove: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
    const style: React.CSSProperties = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined
    };

    return (
        <section
            ref={setNodeRef}
            style={style}
            className={`${styles.sectionBlock} ${isDragging ? styles.sectionDragging : ''}`}
        >
            <div className={styles.sectionHeader}>
                <button
                    className={styles.sectionHandle}
                    {...attributes}
                    {...listeners}
                    title='Glisser pour déplacer la section'
                    aria-label='Déplacer la section'
                >
                    <span className={`icon icon-drag ${styles.handleIcon}`} />
                </button>
                {/* The title is optional: left empty, the section renders with no
                    heading on the home. Committed on every keystroke — the server
                    sync is already debounced, so nothing can be lost on exit. */}
                <input
                    className={styles.sectionTitleInput}
                    value={section.title ?? ''}
                    onChange={(e) => renameSection(section.id, e.target.value)}
                    placeholder='Titre (facultatif)'
                    maxLength={40}
                    aria-label='Titre de la section'
                />
                {/*
                 * Deux réglages, et le second dépend du premier : « démarre
                 * repliée » n'apparaît que si la section peut l'être. Une
                 * section qu'on ne peut pas déplier mais qui démarre repliée
                 * serait simplement invisible, et le store retire d'ailleurs le
                 * second drapeau avec le premier.
                 */}
                <Checkbox
                    className={styles.sectionToggle}
                    checked={section.collapsible === true}
                    onChange={(checked) => setSectionCollapsible(section.id, checked)}
                >
                    Repliable
                </Checkbox>
                {section.collapsible === true && (
                    <Checkbox
                        className={styles.sectionToggle}
                        checked={section.collapsed === true}
                        onChange={(checked) => setSectionCollapsed(section.id, checked)}
                    >
                        Repliée au départ
                    </Checkbox>
                )}
                {/* Plus de pastille de genre : une section n'en a plus. Reste le
                    nombre de tuiles, qui dit quelque chose de vrai. */}
                <span className={styles.sectionCount}>{section.items.length}</span>
                <button
                    className={`${styles.tileAction} ${styles.tileRemove} ${styles.sectionRemove}`}
                    onClick={onRemove}
                    title='Supprimer la section'
                    aria-label='Supprimer la section'
                >
                    <span className={`icon icon-x ${styles.actionIconRemove}`} />
                </button>
            </div>
            <SectionTiles
                section={section}
                devices={devices}
                onAdd={onAdd}
                onAddFolder={onAddFolder}
                onOpenFolder={onOpenFolder}
                onEditShortcut={onEditShortcut}
                onRemoveFolder={onRemoveFolder}
            />
            {openFolder && <FolderPanel folder={openFolder} onClose={onCloseFolder} />}
        </section>
    );
}

export interface EditableHomeProps {
    /**
     * Entré depuis un accueil vide : poser une première section et ouvrir le
     * marché dessus, sans rien demander. Il n'y a plus de genre à choisir, donc
     * plus rien à faire confirmer avant de montrer ce qu'on peut ajouter.
     */
    autoOpenAdd?: boolean;
}

/**
 * Edit mode rendered straight onto the grid: the same tiles as the home, grouped
 * by section. A single DndContext drives every level — sections reorder by their
 * header handle, tiles reorder inside their zone *and* can be dragged into any
 * other section, into a folder, or back out of one. A trailing "+" per section
 * opens the marché; a final "+" adds a whole section, sur-le-champ.
 */
export function EditableHome({ autoOpenAdd = false }: EditableHomeProps) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const [addTarget, setAddTarget] = useState<string | null>(null);
    const [editShortcut, setEditShortcut] = useState<ShortcutEdit | null>(null);
    const [confirmRemove, setConfirmRemove] = useState<HomeSection | null>(null);
    /** Le dossier déplié, par son id (relu dans la disposition à chaque rendu). */
    const [openFolderId, setOpenFolderId] = useState<string | null>(null);
    /** Le dossier dont on demande le retrait, quand il n'est pas vide. */
    const [confirmFolder, setConfirmFolder] = useState<FolderRemoval | null>(null);
    /** Tile currently riding in the drag overlay (null when dragging a section). */
    const [activeTileId, setActiveTileId] = useState<string | null>(null);
    /** Where that tile started, so a cancelled drag puts it back. */
    const dragOrigin = useRef<{ zoneId: string; beforeId: string | null } | null>(null);
    /**
     * Le déplacement du pointeur au moment du dernier changement de contenant.
     *
     * C'est ce qui empêche la boucle décrite dans `onDragOver` : tant que le
     * pointeur n'a pas bougé, il n'a rien demandé de nouveau.
     */
    const lastHandover = useRef<string | null>(null);

    const sections = layout.sections;
    const ids = sections.map((s) => s.id);
    const zones = useMemo(() => buildZones(sections, openFolderId), [sections, openFolderId]);
    /** Le dossier déplié, relu dans la disposition : supprimé, il se referme. */
    const openFolder = useMemo(() => {
        const zone = zones.find((z) => z.kind === 'folder');
        return zone?.kind === 'folder' ? zone : null;
    }, [zones]);
    useEffect(() => {
        if (openFolderId !== null && openFolder === null) setOpenFolderId(null);
    }, [openFolderId, openFolder]);

    /**
     * Pose un dossier, et ne le déplie que s'il y a de quoi le remplir.
     *
     * Un dossier ne se garnit qu'en y tirant une carte **déjà posée** sur
     * l'accueil. Sur un accueil qui n'en porte aucune, l'ouvrir montrerait une
     * rangée vide et une consigne impossible à suivre : le dossier est alors
     * simplement ajouté, et attendra la première fonctionnalité.
     */
    const startFolder = useCallback((sectionId: string) => {
        const folderId = addFolder(sectionId);
        if (folderId === null) return;
        const current = getHomeLayout();
        const folded = new Set<string>(foldedFeatureIds(current));
        const onGrid = placedFeatureIds(current).filter((id) => !folded.has(id));
        if (onGrid.length > 0) setOpenFolderId(folderId);
    }, []);

    /**
     * L'entrée « accueil vide », jouée une fois.
     *
     * Le garde-fou n'est pas décoratif : cet effet **écrit** dans la disposition,
     * et un second passage (montage-démontage-remontage) poserait une deuxième
     * section vide sans que rien ne l'ait demandé.
     */
    const seeded = useRef(false);
    useEffect(() => {
        if (!autoOpenAdd || seeded.current) return;
        seeded.current = true;
        setAddTarget(addSection());
    }, [autoOpenAdd]);

    // 8px activation distance: a plain click (e.g. the × button, or a folder card
    // being opened) never starts a drag, and there's no stray text selection on press.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    // A dialog target must follow the live layout (a removed section closes it).
    const addSectionTarget = sections.find((s) => s.id === addTarget) ?? null;
    const editTarget = editShortcut ? (sections.find((s) => s.id === editShortcut.sectionId) ?? null) : null;

    /**
     * Sections, zones and tiles share one DndContext (that's what lets a tile
     * cross into another section or into a folder), so targets are filtered per
     * drag:
     *  - dragging a section → only other sections are candidates;
     *  - dragging a **feature** over the inside of a folder card → that card wins
     *    outright, which is what makes « ranger dedans » distinct from « poser à
     *    côté »;
     *  - otherwise → the zone under the pointer wins first (a folder panel before
     *    the section that carries it, since the panel sits inside it), then the
     *    closest tile inside that zone, so an empty zone is still droppable and a
     *    tile can never land where the pointer isn't.
     */
    const collisionDetection = useCallback<CollisionDetection>(
        (args) => {
            const sectionIds = new Set(sections.map((s) => s.id));
            const isSection = (id: string | number) => sectionIds.has(String(id));
            const activeId = String(args.active.id);

            if (isSection(activeId)) {
                return closestCenter({
                    ...args,
                    droppableContainers: args.droppableContainers.filter((c) => isSection(c.id))
                });
            }

            // The keyboard sensor drags without a pointer, so `pointerWithin` would
            // find nothing: keep the plain in-zone sorting it had before.
            if (!args.pointerCoordinates) {
                const own = zoneOf(zones, activeId);
                const ownTiles = new Set(own ? own.tileIds : []);
                return closestCenter({
                    ...args,
                    droppableContainers: args.droppableContainers.filter((c) => ownTiles.has(String(c.id)))
                });
            }

            if (isFeatureTile(activeId)) {
                // La carte du dossier **déplié** est exclue : sa rangée est
                // ouverte juste en dessous, et pendant qu'on en tire une carte
                // dehors, repasser au-dessus de sa tuile rallumerait « ranger
                // dedans » en plein geste de sortie.
                const openTile = openFolderId === null ? null : folderDropId(openFolderId);
                const intoFolder = pointerWithin({
                    ...args,
                    droppableContainers: args.droppableContainers.filter(
                        (c) => String(c.id).startsWith(FOLDER_DROP_PREFIX) && String(c.id) !== openTile
                    )
                });
                if (intoFolder.length > 0) return intoFolder;
            }

            const zoneIds = new Set(zones.map((z) => z.id));
            const hovered = pointerWithin({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => zoneIds.has(String(c.id)))
            });
            if (hovered.length === 0) return [];

            // Le panneau d'un dossier est **dans** le bloc de sa section : les deux
            // rectangles se recouvrent, et sans cette préférence explicite on ne
            // pourrait jamais viser le dossier ouvert.
            const best = hovered.find((c) => String(c.id).startsWith(FOLDER_ZONE_PREFIX)) ?? hovered[0];
            const zone = zones.find((z) => z.id === String(best.id));
            const zoneTileIds = new Set(zone ? zone.tileIds : []);
            const tiles = closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => zoneTileIds.has(String(c.id)))
            });
            return tiles.length > 0 ? tiles : [best];
        },
        [sections, zones, openFolderId]
    );

    /** The card the overlay carries — looked up live, since the tile changes
     *  zone mid-drag. */
    const activeTile = useMemo(() => {
        if (!activeTileId) return null;
        const owner = zoneOf(zones, activeTileId);
        if (!owner) return null;
        if (owner.kind === 'folder') return featureTileVisual(activeTileId as HomeFeatureId);
        const tile = tileIn(owner.section, activeTileId);
        return tile === undefined ? null : homeTileVisual(tile, devices, { editing: true });
    }, [activeTileId, zones, devices]);

    const onDragStart = (e: DragStartEvent) => {
        const id = String(e.active.id);
        // Sections drag as themselves (no overlay); only tiles get one.
        if (sections.some((s) => s.id === id)) return;
        lastHandover.current = null;
        const owner = zoneOf(zones, id);
        // La tuile devant laquelle elle se trouvait : c'est ce qui la remet
        // exactement où elle était si le glissé est abandonné. Un rang aurait
        // désigné une place qui a bougé entre-temps.
        const tiles = owner ? owner.tileIds : [];
        const at = tiles.indexOf(id);
        dragOrigin.current = owner ? { zoneId: owner.id, beforeId: at >= 0 ? (tiles[at + 1] ?? null) : null } : null;
        setActiveTileId(id);
    };

    /**
     * A tile joins the hovered zone as soon as it enters it, rather than on drop.
     * That's what makes the move feel like the in-zone sort: the tile is really
     * part of the target grid, so its neighbours slide aside to open the slot, and
     * the zone it left closes up behind it.
     *
     * Rien n'est lu ici que des **identités** : cet événement part du pointeur,
     * donc bien plus souvent que React ne rend, et `zones` décrit toujours un
     * état d'avant. Le store, lui, résout les positions sur l'état courant.
     *
     * ## Un changement de contenant par mouvement du pointeur, pas davantage
     *
     * Changer une tuile de contenant **change la hauteur des deux** : la source se
     * referme, la cible s'ouvre, et tout ce qui suit remonte. Sous un pointeur
     * resté immobile, ce n'est donc plus le même contenant qui se trouve. dnd-kit
     * remesure (la mesure est en continu, elle doit l'être pour qu'un lâcher tombe
     * juste), rappelle cet événement, et l'on rend la tuile — ce qui défait la
     * reflow, ramène le contenant d'origine sous le curseur, et recommence. Une
     * boucle qui ne tient à aucun geste, et que React finit par arrêter en
     * dépilant l'application entière (« Maximum update depth »).
     *
     * `delta` est le déplacement du pointeur depuis le début du glissé : deux
     * événements qui le partagent décrivent le **même** geste. Le second n'a donc
     * rien de neuf à demander, et un changement de contenant par position borne la
     * réaction en chaîne à un seul tour.
     */
    const onDragOver = (e: DragOverEvent) => {
        const { active, over, delta } = e;
        if (!over || !activeTileId) return;
        const activeId = String(active.id);
        const source = zoneOf(zones, activeId);
        const target = resolveDropTarget(zones, String(over.id));
        if (!source || !target) return;
        if (target.zone.id === source.id) return;

        const at = `${delta.x},${delta.y}`;
        if (lastHandover.current === at) return;
        lastHandover.current = at;
        transferBetween(source, target.zone, activeId, target.beforeId);
    };

    const onDragEnd = (e: DragEndEvent) => {
        setActiveTileId(null);
        dragOrigin.current = null;
        lastHandover.current = null;
        const { active, over } = e;
        if (!over) return;
        const activeId = String(active.id);
        const overId = String(over.id);

        // A section was dragged by its handle → reorder the blocks.
        if (sections.some((s) => s.id === activeId)) {
            if (activeId === overId) return;
            const from = ids.indexOf(activeId);
            const to = ids.indexOf(overId);
            if (from < 0 || to < 0) return;
            setSectionOrder(arrayMove(ids, from, to));
            return;
        }

        // Lâchée dans une carte de dossier fermée : elle s'y range. Le seul cas
        // qui n'a pas eu lieu au survol — la carte n'aurait eu nulle part où
        // s'afficher entre-temps, le dossier étant justement fermé.
        if (overId.startsWith(FOLDER_DROP_PREFIX)) {
            if (isFeatureTile(activeId)) fileInFolder(overId.slice(FOLDER_DROP_PREFIX.length), activeId, null);
            return;
        }

        // The tile already sits in its target zone (moved on hover); all that is
        // left is settling its position inside it.
        const source = zoneOf(zones, activeId);
        const target = resolveDropTarget(zones, overId);
        if (!source || !target || target.zone.id !== source.id) return;
        moveWithin(source, activeId, target.beforeId);
    };

    /** Escape mid-drag: undo the hover-moves and put the tile back where it was. */
    const onDragCancel = () => {
        const origin = dragOrigin.current;
        const id = activeTileId;
        setActiveTileId(null);
        dragOrigin.current = null;
        lastHandover.current = null;
        if (!origin || !id) return;
        const current = zoneOf(zones, id);
        const home = zones.find((z) => z.id === origin.zoneId);
        if (!current || !home || current.id === home.id) return;
        transferBetween(current, home, id, origin.beforeId);
    };

    /** Empty sections go without asking; a populated one asks first (shortcuts
     *  carry real typing that can't be re-added in one click). */
    const requestRemove = (section: HomeSection) => {
        if (section.items.length === 0) removeSection(section.id);
        else setConfirmRemove(section);
    };

    const doRemove = () => {
        if (confirmRemove) removeSection(confirmRemove.id);
        setConfirmRemove(null);
    };

    /**
     * Un dossier vide s'en va sans rien demander (le recréer est un clic) ; un
     * dossier plein prévient, parce que son retrait emporte aussi les tuiles
     * qu'il tenait hors de l'accueil.
     */
    const requestRemoveFolder = (sectionId: string, folder: HomeFolder) => {
        if (folder.items.length === 0) removeTile(sectionId, folder.id);
        else setConfirmFolder({ sectionId, folder });
    };

    const doRemoveFolder = () => {
        if (confirmFolder) removeTile(confirmFolder.sectionId, confirmFolder.folder.id);
        setConfirmFolder(null);
    };

    return (
        <div className={styles.editRoot}>
            <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                // Tiles change zone mid-drag, so the droppable rects must be
                // re-measured continuously or drops would land on stale positions.
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragCancel={onDragCancel}
                onDragEnd={onDragEnd}
            >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    {sections.map((section) => (
                        <SortableSection
                            key={section.id}
                            section={section}
                            devices={devices}
                            openFolder={openFolder?.sectionId === section.id ? openFolder.folder : null}
                            onAdd={() => setAddTarget(section.id)}
                            onAddFolder={() => startFolder(section.id)}
                            onOpenFolder={(folder) =>
                                setOpenFolderId((current) => (current === folder.id ? null : folder.id))
                            }
                            onCloseFolder={() => setOpenFolderId(null)}
                            onEditShortcut={(item) => setEditShortcut({ sectionId: section.id, item })}
                            onRemoveFolder={(folder) => requestRemoveFolder(section.id, folder)}
                            onRemove={() => requestRemove(section)}
                        />
                    ))}
                </SortableContext>

                <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
                    {activeTile ? (
                        <div className={styles.overlayTile}>
                            <TileCard visual={activeTile} />
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>

            {/* Ajoutée sur-le-champ : il n'y a plus de genre à choisir, donc plus
                de question à poser. Le marché s'ouvre dans la foulée sur la
                section neuve, qui n'a par définition rien à montrer. */}
            <button type='button' className={styles.addSection} onClick={() => setAddTarget(addSection())}>
                <span className={`icon icon-plus ${styles.addTileIcon}`} />
                <span className={styles.addTileLabel}>Ajouter une section</span>
            </button>

            <AddTileMarket
                section={editShortcut ? editTarget : addSectionTarget}
                editShortcut={editShortcut?.item ?? null}
                onClose={() => {
                    setAddTarget(null);
                    setEditShortcut(null);
                }}
            />

            <Dialog
                open={confirmFolder !== null}
                onClose={() => setConfirmFolder(null)}
                title='Supprimer le dossier ?'
                onSubmit={doRemoveFolder}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmFolder(null)}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={doRemoveFolder}>
                            Supprimer
                        </Button>
                    </>
                }
            >
                <p className={styles.confirmText}>{confirmFolder ? folderRemovalWarning(confirmFolder.folder) : ''}</p>
            </Dialog>

            <Dialog
                open={confirmRemove !== null}
                onClose={() => setConfirmRemove(null)}
                title='Supprimer la section ?'
                onSubmit={doRemove}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmRemove(null)}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={doRemove}>
                            Supprimer
                        </Button>
                    </>
                }
            >
                <p className={styles.confirmText}>{confirmRemove ? removalWarning(confirmRemove) : ''}</p>
            </Dialog>
        </div>
    );
}

export default EditableHome;
