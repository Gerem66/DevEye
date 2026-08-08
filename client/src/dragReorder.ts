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
}

/** La moitié de l'écart entre deux lignes, où se centre la barre d'insertion. */
function halfGap(list: HTMLElement): number {
    return (parseFloat(getComputedStyle(list).rowGap) || 0) / 2;
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
    onDragStateChange
}: DragReorderOptions): DragReorder<L, B> {
    const listRef = useRef<L | null>(null);
    const barRef = useRef<B | null>(null);
    /** L'interstice que marque la barre, ou `null` tant qu'elle est cachée. */
    const gapRef = useRef<number | null>(null);
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

    const rowEls = useCallback(
        () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(rowSelectorRef.current) ?? []),
        []
    );

    const hideBar = useCallback(() => {
        gapRef.current = null;
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    /** Dresse la barre dans l'interstice `index` (0 = au-dessus de la première). */
    const showBar = useCallback(
        (index: number) => {
            const list = listRef.current;
            const bar = barRef.current;
            if (!list || !bar || gapRef.current === index) return;
            const rows = rowEls();
            if (rows.length === 0) return;

            // Le vrai milieu de l'interstice, pris sur les lignes qui le bordent :
            // la barre est centrée par construction, et non par un décalage
            // correctif qu'il faudrait ajuster à chaque changement d'écart.
            const boxes = rows.map((el) => el.getBoundingClientRect());
            let centre: number;
            if (index <= 0) centre = boxes[0].top - halfGap(list);
            else if (index >= boxes.length) centre = boxes[boxes.length - 1].bottom + halfGap(list);
            else centre = (boxes[index - 1].bottom + boxes[index].top) / 2;

            gapRef.current = index;
            const listBox = list.getBoundingClientRect();
            // Moins la moitié de son épaisseur, lue dans le DOM pour que celle-ci
            // ne soit définie que dans la feuille de style de la feature.
            bar.style.transform = `translateY(${centre - listBox.top - bar.offsetHeight / 2}px)`;
            bar.style.opacity = '1';
        },
        [rowEls]
    );

    /** L'interstice le plus proche : chaque bord de ligne est un candidat. */
    const gapAt = useCallback(
        (clientY: number): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (const [i, el] of rowEls().entries()) {
                const box = el.getBoundingClientRect();
                for (const [y, gap] of [
                    [box.top, i],
                    [box.bottom, i + 1]
                ]) {
                    const distance = Math.abs(clientY - y);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = gap;
                    }
                }
            }
            return best;
        },
        [rowEls]
    );

    const showBarRef = useRef(showBar);
    showBarRef.current = showBar;
    const gapAtRef = useRef(gapAt);
    gapAtRef.current = gapAt;

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
                showBarRef.current(gapAtRef.current(e.clientY));
            },
            up: (e) => {
                const press = pressRef.current;
                if (!press || e.pointerId !== press.pointerId) return;
                const dragged = draggedRef.current;
                const gap = gapRef.current;
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
