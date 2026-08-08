import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject
} from 'react';

/** Déplacement du pointeur, en px, au-delà duquel une pression devient un glissé. */
const DRAG_THRESHOLD = 6;

/** Ce que peut identifier une ligne : un entier (SQL) ou un uuid (appareils). */
type RowId = string | number;

/**
 * Comment la liste est disposée — donc où se glisse un interstice.
 *
 * `rows` : une colonne, les interstices sont horizontaux, la barre aussi.
 * `grid` : plusieurs colonnes, les interstices sont **entre deux cartes d'une
 * même rangée**, et la barre est verticale, haute comme la rangée visée.
 */
type Layout = 'rows' | 'grid';

export interface DragReorder<L extends HTMLElement, B extends HTMLElement> {
    /** À poser sur le conteneur de la liste (il doit être `position: relative`). */
    listRef: RefObject<L | null>;
    /** À poser sur la barre d'insertion, cachée par défaut. */
    barRef: RefObject<B | null>;
    /** À câbler sur le `onPointerDown` de la poignée d'une ligne. */
    onGripPointerDown: (e: ReactPointerEvent, id: RowId) => void;
    /** La ligne en cours de déplacement, à estomper. `null` hors glissé. */
    draggingId: RowId | null;
}

interface DragReorderOptions {
    /** Les identifiants, dans l'ordre affiché. */
    ids: RowId[];
    /** L'attribut que porte chaque ligne, par exemple `[data-repo-card]`. */
    rowSelector: string;
    /** L'ordre complet après un dépôt ; jamais appelé si rien n'a bougé. */
    onReorder: (ids: RowId[]) => void;
    /** Un glissé commence ou finit — l'appelant suspend ses relectures. */
    onDragStateChange?: (dragging: boolean) => void;
    /** La disposition de la liste. Une colonne par défaut. */
    layout?: Layout;
}

/**
 * Où poser la barre d'insertion, en coordonnées de la fenêtre.
 *
 * `x` à `null` : la barre garde la largeur que lui donne la feuille de style
 * (elle traverse la liste, cas d'une colonne). `height` à `null` : elle garde
 * son épaisseur, et `y` en est alors le **centre** et non le haut.
 */
interface Spot {
    /** L'interstice visé : 0 = avant la première ligne. */
    gap: number;
    x: number | null;
    y: number;
    height: number | null;
}

/** La moitié de l'écart entre deux cases, où se centre la barre d'insertion. */
function halfGap(list: HTMLElement, axis: 'rowGap' | 'columnGap'): number {
    return (parseFloat(getComputedStyle(list)[axis]) || 0) / 2;
}

/**
 * L'interstice visé dans une colonne : chaque bord horizontal est un candidat.
 *
 * Le centre de l'interstice se prend sur la case qui le borde, à la moitié de
 * l'écart : la barre est centrée par construction, et non par un décalage
 * correctif qu'il faudrait ajuster à chaque changement d'écart.
 */
function rowsSpot(list: HTMLElement, boxes: DOMRect[], clientY: number): Spot {
    const half = halfGap(list, 'rowGap');
    let best: Spot = { gap: 0, x: null, y: boxes[0].top - half, height: null };
    let bestDistance = Infinity;
    for (const [i, box] of boxes.entries()) {
        for (const [edge, gap, centre] of [
            [box.top, i, box.top - half],
            [box.bottom, i + 1, box.bottom + half]
        ]) {
            const distance = Math.abs(clientY - edge);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { gap, x: null, y: centre, height: null };
            }
        }
    }
    return best;
}

/** Distance à un bord vertical, nulle tant qu'on reste dans la bande de sa rangée. */
function edgeDistance(clientX: number, clientY: number, box: DOMRect, edge: number): number {
    const dy = clientY < box.top ? box.top - clientY : clientY > box.bottom ? clientY - box.bottom : 0;
    return Math.hypot(clientX - edge, dy);
}

/**
 * Les cartes regroupées par rangée, dans l'ordre de lecture.
 *
 * Le critère est le **chevauchement vertical** avec la rangée en cours, et non
 * l'égalité des `top` : deux cartes d'une même rangée s'étirent à la même
 * hauteur, mais un pixel d'écart suffirait à faire éclater le regroupement.
 */
function rowsOf(boxes: DOMRect[]): DOMRect[][] {
    const rows: DOMRect[][] = [];
    for (const box of boxes) {
        const row = rows[rows.length - 1];
        if (row && box.top < row[0].bottom) row.push(box);
        else rows.push([box]);
    }
    return rows;
}

/**
 * L'interstice visé dans une grille : **combien de cartes le pointeur a-t-il
 * dépassées**, dans l'ordre de lecture.
 *
 * Un comptage rangée par rangée, et non la recherche du bord le plus proche.
 * Celle-ci se trompait dès que la grille se repliait sur une seule colonne :
 * l'intention y est purement verticale, alors que le bord le plus proche se
 * décide sur l'abscisse — et la poignée étant à gauche de la carte, le pointeur
 * y traîne. « Déposer à la fin » donnait alors « avant la dernière carte », et
 * la dernière position devenait tout bonnement inatteignable.
 *
 * Dans la rangée que le pointeur traverse, c'est l'axe qui offre réellement un
 * choix qui tranche : l'abscisse quand plusieurs cartes s'y partagent la
 * largeur, l'ordonnée quand elle n'en porte qu'une — c'est-à-dire exactement la
 * règle des listes en colonne, retrouvée sans être écrite deux fois.
 *
 * Reste à placer la barre. Un interstice qui tombe sur un retour à la ligne se
 * dessine à **deux** endroits — fin d'une rangée, début de la suivante — pour un
 * seul et même rang. On garde celui que le pointeur désigne ; ailleurs les deux
 * candidats se confondent, la gouttière étant partagée.
 */
function gridSpot(list: HTMLElement, boxes: DOMRect[], clientX: number, clientY: number): Spot {
    const half = halfGap(list, 'columnGap');
    let gap = 0;
    for (const row of rowsOf(boxes)) {
        const { top, bottom } = row[0];
        // Entièrement au-dessus du pointeur : toute la rangée est dépassée.
        if (clientY > bottom) {
            gap += row.length;
            continue;
        }
        // Entièrement en dessous : celle-ci et toutes les suivantes restent
        // devant lui — y compris quand il flotte dans l'écart entre deux rangées.
        if (clientY < top) break;
        for (const box of row) {
            const past = row.length > 1 ? clientX > (box.left + box.right) / 2 : clientY > (top + bottom) / 2;
            if (past) gap++;
        }
        break;
    }

    const next = boxes[Math.min(gap, boxes.length - 1)];
    const previous = boxes[Math.max(gap - 1, 0)];
    const nextEdge = next.left - half;
    const previousEdge = previous.right + half;
    const atNext: Spot = { gap, x: nextEdge, y: next.top, height: next.height };
    const atPrevious: Spot = { gap, x: previousEdge, y: previous.top, height: previous.height };
    if (gap === 0) return atNext;
    if (gap === boxes.length) return atPrevious;
    return edgeDistance(clientX, clientY, next, nextEdge) <= edgeDistance(clientX, clientY, previous, previousEdge)
        ? atNext
        : atPrevious;
}

/** L'ordre que devient `ids` quand `draggedId` atterrit dans l'interstice `gap`. */
function reordered(ids: RowId[], draggedId: RowId, gap: number): RowId[] | null {
    const from = ids.indexOf(draggedId);
    if (from === -1) return null;
    const rest = ids.filter((id) => id !== draggedId);
    // Retirer d'abord la ligne déplacée décale d'un cran tous les interstices
    // qui la suivaient.
    rest.splice(from < gap ? gap - 1 : gap, 0, ids[from]);
    return rest.every((id, i) => id === ids[i]) ? null : rest;
}

/**
 * Réordonner une liste au glisser-déposer, partout de la même façon.
 *
 * Uptime, Git, Monitoring et les bases de données rangent tous une liste
 * verticale ; ce geste avait été écrit trois fois avant d'être rassemblé ici.
 * Chaque feature garde en propre ce qui la distingue vraiment — l'apparence de
 * ses lignes, de sa poignée et de sa barre d'insertion — et rien d'autre.
 *
 * ## Une colonne, ou une grille
 *
 * Le portefeuille des projets est une grille à plusieurs colonnes : deux cartes
 * côte à côte y partagent le même haut et le même bas, et un interstice choisi
 * sur la seule ordonnée n'y voudrait rien dire. `layout: 'grid'` change donc les
 * candidats — les bords **verticaux** plutôt qu'horizontaux — et la barre, qui
 * se dresse dans la gouttière, haute comme la rangée visée.
 *
 * Ce qui ne change pas : l'ordre résultant. Une grille reste une suite, et
 * {@link reordered} n'a jamais besoin de savoir combien de colonnes elle a.
 *
 * ## Pointer Events, jamais l'API `draggable` du HTML5
 *
 * Celle-ci confie le geste à la session de glissé du navigateur, et sur cette
 * plateforme une session interrompue peut laisser la page entière convaincue
 * qu'un glissé est toujours en cours : plus rien ne répond au clic, pas même le
 * menu contextuel, jusqu'à ce qu'un événement extérieur la casse. C'est une
 * défaillance de plateforme, qu'aucun soin apporté à `dragend` ne rattrape —
 * la seule parade est de ne jamais lui confier le geste. Voir aussi
 * {@link ./nativeDrag}, qui refuse celles que le navigateur ouvre tout seul.
 *
 * ## Ce qui bouge, et ce qui n'est pas touché
 *
 * La barre d'insertion se tient **dans l'interstice visé** ; aucune ligne n'est
 * déplacée ni restylée pendant le geste, de sorte que ce qu'on voit est
 * exactement là où ça tombe. Elle est pilotée par le DOM, pas par un état React :
 * un rendu à chaque mouvement du pointeur coûterait cher pour une position que
 * seul le style d'un élément traduit.
 *
 * ## Une poignée, pas la ligne entière
 *
 * C'est ce qui garde la ligne cliquable, et c'est ce qui rend le geste possible
 * au doigt : seule la poignée doit renoncer au défilement tactile
 * (`touch-action: none`), donc une pression ailleurs fait toujours défiler la
 * page. Le clic qui suit une pression sur la poignée ne peut pas ouvrir la
 * ligne dès lors que la poignée n'est pas un descendant de la zone cliquable —
 * c'est la disposition que suivent les listes appelantes.
 */
export function useDragReorder<L extends HTMLElement = HTMLElement, B extends HTMLElement = HTMLElement>({
    ids,
    rowSelector,
    onReorder,
    onDragStateChange,
    layout = 'rows'
}: DragReorderOptions): DragReorder<L, B> {
    const listRef = useRef<L | null>(null);
    const barRef = useRef<B | null>(null);
    /** Où se tient la barre, ou `null` tant qu'elle est cachée. */
    const spotRef = useRef<Spot | null>(null);
    /** La pression suivie, tant que le seuil n'est pas franchi. */
    const pressRef = useRef<{ id: RowId; pointerId: number; x: number; y: number } | null>(null);
    /** La ligne réellement glissée (seuil franchi). La logique lit celle-ci. */
    const draggedRef = useRef<RowId | null>(null);
    /** Le même identifiant, en état, seulement pour estomper la ligne : posé
     *  deux fois par glissé, jamais à chaque mouvement du pointeur. */
    const [draggingId, setDraggingId] = useState<RowId | null>(null);

    // Les entrées volatiles passent par des `ref` : les écouteurs ci-dessous
    // sont créés **une seule fois**, ce qui garantit que celui qu'on retire est
    // exactement celui qu'on avait posé. Des fonctions recréées à chaque rendu
    // rendraient ce couple bancal, et une fuite d'écouteur en découlerait.
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const rowSelectorRef = useRef(rowSelector);
    rowSelectorRef.current = rowSelector;
    const onReorderRef = useRef(onReorder);
    onReorderRef.current = onReorder;
    const onDragStateChangeRef = useRef(onDragStateChange);
    onDragStateChangeRef.current = onDragStateChange;
    const layoutRef = useRef(layout);
    layoutRef.current = layout;

    const rowEls = useCallback(
        () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(rowSelectorRef.current) ?? []),
        []
    );

    const hideBar = useCallback(() => {
        spotRef.current = null;
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    /** Dresse la barre dans l'interstice le plus proche du pointeur. */
    const showBar = useCallback(
        (clientX: number, clientY: number) => {
            const list = listRef.current;
            const bar = barRef.current;
            if (!list || !bar) return;
            const boxes = rowEls().map((el) => el.getBoundingClientRect());
            if (boxes.length === 0) return;

            const spot =
                layoutRef.current === 'grid' ? gridSpot(list, boxes, clientX, clientY) : rowsSpot(list, boxes, clientY);

            // Rien à réécrire tant que la barre est déjà là : sur une grille, le
            // même numéro d'interstice peut désigner deux endroits (fin d'une
            // rangée, début de la suivante), d'où la comparaison de la position
            // entière et non du seul numéro.
            const held = spotRef.current;
            if (held && held.gap === spot.gap && held.x === spot.x && held.y === spot.y) return;
            spotRef.current = spot;

            const listBox = list.getBoundingClientRect();
            // La barre garde de la feuille de style de la feature ce qui lui
            // appartient : son épaisseur en liste, sa largeur en grille. On ne
            // pose ici que ce que la disposition impose.
            if (spot.height !== null) bar.style.height = `${spot.height}px`;
            // Aux deux extrémités d'une rangée, la gouttière n'existe pas : la
            // barre se retrouverait à cheval sur le bord de la liste, donc
            // rognée par la boîte défilante. On la ramène juste à l'intérieur.
            const half = bar.offsetWidth / 2;
            const centre = spot.x === null ? 0 : Math.min(Math.max(spot.x - listBox.left, half), listBox.width - half);
            const dx = spot.x === null ? 0 : centre - half;
            const dy = spot.y - listBox.top - (spot.height === null ? bar.offsetHeight / 2 : 0);
            bar.style.transform = `translate(${dx}px, ${dy}px)`;
            bar.style.opacity = '1';
        },
        [rowEls]
    );

    const showBarRef = useRef(showBar);
    showBarRef.current = showBar;

    // Les cinq écouteurs, créés une fois pour toutes (voir la note sur les
    // `ref` plus haut). `handlers.current` casse la circularité : `endDrag` doit
    // retirer des fonctions qui, elles, doivent pouvoir l'appeler.
    const handlers = useRef<{
        move: (e: PointerEvent) => void;
        up: (e: PointerEvent) => void;
        cancel: (e: PointerEvent) => void;
        blur: () => void;
        keydown: (e: KeyboardEvent) => void;
    } | null>(null);

    const endDrag = useCallback(() => {
        const h = handlers.current;
        if (h) {
            window.removeEventListener('pointermove', h.move);
            window.removeEventListener('pointerup', h.up);
            window.removeEventListener('pointercancel', h.cancel);
            window.removeEventListener('blur', h.blur);
            window.removeEventListener('keydown', h.keydown);
        }
        hideBar();
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        pressRef.current = null;
        if (draggedRef.current !== null) {
            draggedRef.current = null;
            setDraggingId(null);
            onDragStateChangeRef.current?.(false);
        }
    }, [hideBar]);

    const endDragRef = useRef(endDrag);
    endDragRef.current = endDrag;

    if (handlers.current === null) {
        handlers.current = {
            move: (e) => {
                const press = pressRef.current;
                if (!press || e.pointerId !== press.pointerId) return;
                if (draggedRef.current === null) {
                    // Sous le seuil : ce peut encore n'être qu'un clic.
                    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
                    draggedRef.current = press.id;
                    setDraggingId(press.id);
                    onDragStateChangeRef.current?.(true);
                    document.body.style.cursor = 'grabbing';
                    document.body.style.userSelect = 'none';
                }
                showBarRef.current(e.clientX, e.clientY);
            },
            up: (e) => {
                const press = pressRef.current;
                if (!press || e.pointerId !== press.pointerId) return;
                const dragged = draggedRef.current;
                const gap = spotRef.current?.gap ?? null;
                endDragRef.current();
                if (dragged !== null && gap !== null) {
                    const next = reordered(idsRef.current, dragged, gap);
                    if (next) onReorderRef.current(next);
                }
            },
            cancel: (e) => {
                if (pressRef.current?.pointerId !== e.pointerId) return;
                endDragRef.current();
            },
            // Un glissé quitté en plein geste (alt-tab, dialogue natif) ne doit
            // pas rester en suspens.
            blur: () => endDragRef.current(),
            keydown: (e) => {
                if (e.key === 'Escape') endDragRef.current();
            }
        };
    }

    // Ceinture et bretelles : tout relâcher si la liste disparaît en plein geste
    // (la popup de la feature qui se ferme, par exemple).
    useEffect(() => () => endDragRef.current(), []);

    const onGripPointerDown = useCallback((e: ReactPointerEvent, id: RowId) => {
        // Bouton principal / premier contact seulement. Rien d'autre à filtrer :
        // c'est câblé sur la poignée seule.
        if (e.button !== 0) return;
        const h = handlers.current;
        if (!h) return;
        pressRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        window.addEventListener('pointermove', h.move);
        window.addEventListener('pointerup', h.up);
        window.addEventListener('pointercancel', h.cancel);
        window.addEventListener('blur', h.blur);
        window.addEventListener('keydown', h.keydown);
    }, []);

    return { listRef, barRef, onGripPointerDown, draggingId };
}
