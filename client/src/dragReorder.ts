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
 * `rows` : une colonne, les interstices sont horizontaux, la barre aussi.
 * `grid` : plusieurs colonnes, les interstices sont entre deux cartes d'une même
 * rangée, et la barre est verticale, haute comme la rangée visée.
 */
type Layout = 'rows' | 'grid';

export interface DragReorder<L extends HTMLElement, B extends HTMLElement> {
    /** À poser sur le conteneur de la liste (il doit être `position: relative`). */
    listRef: RefObject<L | null>;
    /** À poser sur la barre d'insertion, cachée par défaut. */
    barRef: RefObject<B | null>;
    /** À câbler sur le `onPointerDown` de la poignée d'une ligne. */
    onGripPointerDown: (e: ReactPointerEvent, id: RowId) => void;
    /** La ligne en cours de déplacement, à estomper. */
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
    layout?: Layout;
}

/**
 * Où poser la barre d'insertion, en coordonnées de la fenêtre.
 *
 * `x` et `height` à `null` : la barre garde de la feuille de style sa largeur et
 * son épaisseur, et `y` en est alors le centre et non le haut.
 */
interface Spot {
    /** L'interstice visé : 0 = avant la première ligne. */
    gap: number;
    x: number | null;
    y: number;
    height: number | null;
}

function halfGap(list: HTMLElement, axis: 'rowGap' | 'columnGap'): number {
    return (parseFloat(getComputedStyle(list)[axis]) || 0) / 2;
}

/**
 * L'interstice visé dans une colonne : chaque bord horizontal est un candidat.
 * Son centre se prend sur la case qui le borde, à la moitié de l'écart, pour que
 * la barre soit centrée par construction plutôt que par un décalage correctif.
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
 * Les cartes regroupées par rangée, dans l'ordre de lecture. Le critère est le
 * chevauchement vertical et non l'égalité des `top` : un pixel d'écart entre
 * deux cartes d'une même rangée suffirait à faire éclater le regroupement.
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
 * L'interstice visé dans une grille : combien de cartes le pointeur a dépassées,
 * dans l'ordre de lecture. Un comptage rangée par rangée, car la recherche du
 * bord le plus proche se décide sur l'abscisse et rend la dernière position
 * inatteignable dès que la grille se replie sur une colonne.
 *
 * Dans la rangée traversée, c'est l'axe qui offre un choix qui tranche :
 * l'abscisse quand plusieurs cartes s'y partagent la largeur, l'ordonnée sinon.
 * Un interstice qui tombe sur un retour à la ligne se dessine à deux endroits
 * pour un seul rang ; on garde celui que le pointeur désigne.
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
        // Entièrement en dessous : celle-ci et les suivantes restent devant lui,
        // y compris quand il flotte dans l'écart entre deux rangées.
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
 * Réordonner une liste au glisser-déposer. La feature ne garde en propre que
 * l'apparence de ses lignes, de sa poignée et de sa barre d'insertion.
 *
 * Pointer Events, jamais l'API `draggable` du HTML5 : une session de glissé du
 * navigateur interrompue peut laisser la page entière convaincue qu'un glissé
 * est en cours, plus rien ne répondant au clic. Aucun soin apporté à `dragend`
 * ne rattrape cela ; la parade est de ne jamais lui confier le geste. Voir
 * {@link ./nativeDrag}, qui refuse celles que le navigateur ouvre tout seul.
 *
 * Aucune ligne n'est déplacée ni restylée pendant le geste : seule la barre
 * bouge, pilotée par le DOM et non par un état React, un rendu par mouvement du
 * pointeur coûtant cher pour une position que seul un style traduit.
 *
 * Le geste part d'une poignée et non de la ligne entière : elle seule renonce au
 * défilement tactile (`touch-action: none`), et elle doit rester hors de la zone
 * cliquable pour que le clic qui suit n'ouvre pas la ligne.
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
    const spotRef = useRef<Spot | null>(null);
    const pressRef = useRef<{ id: RowId; pointerId: number; x: number; y: number } | null>(null);
    /** La ligne réellement glissée (seuil franchi). La logique lit celle-ci. */
    const draggedRef = useRef<RowId | null>(null);
    /** Le même identifiant en état, seulement pour estomper la ligne : deux
     *  rendus par glissé, et non un par mouvement du pointeur. */
    const [draggingId, setDraggingId] = useState<RowId | null>(null);

    // Les entrées volatiles passent par des `ref` pour que les écouteurs plus bas
    // soient créés une seule fois : celui qu'on retire est alors exactement celui
    // qu'on avait posé, là où des fonctions recréées à chaque rendu fuiraient.
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

            // Sur une grille, un même numéro d'interstice peut désigner deux
            // endroits : on compare la position entière, pas le seul numéro.
            const held = spotRef.current;
            if (held && held.gap === spot.gap && held.x === spot.x && held.y === spot.y) return;
            spotRef.current = spot;

            const listBox = list.getBoundingClientRect();
            // Épaisseur en liste et largeur en grille viennent de la feuille de
            // style de la feature ; on ne pose ici que ce que la disposition impose.
            if (spot.height !== null) bar.style.height = `${spot.height}px`;
            // Aux extrémités d'une rangée il n'y a pas de gouttière : sans ce
            // recentrage la barre déborde et la boîte défilante la rogne.
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

    // `handlers.current` casse la circularité : `endDrag` doit retirer des
    // fonctions qui, elles, doivent pouvoir l'appeler.
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
            // Un glissé quitté en plein geste (alt-tab, dialogue natif).
            blur: () => endDragRef.current(),
            keydown: (e) => {
                if (e.key === 'Escape') endDragRef.current();
            }
        };
    }

    // Tout relâcher si la liste disparaît en plein geste, popup refermée compris.
    useEffect(() => () => endDragRef.current(), []);

    const onGripPointerDown = useCallback((e: ReactPointerEvent, id: RowId) => {
        // Bouton principal / premier contact seulement.
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
