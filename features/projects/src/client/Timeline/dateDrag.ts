import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject
} from 'react';
import type { ProjectCard } from '../../contracts/domain';
import { startOfDay } from './scale';

/**
 * Poser les dates d'une carte à la souris. Trois gestes, un seul mécanisme :
 * une barre déjà sur la frise se déplace ou s'étire, et se ramène dans la zone
 * des cartes sans date pour perdre les siennes ; une pastille de cette zone se
 * dépose sur un jour, qui devient à la fois son début et son échéance ; le « + »
 * de la barre d'outils se dépose de même, pour une tâche ou un jalon qui
 * n'existent pas encore.
 *
 * Rien n'est persisté avant le relâchement, seul un aperçu local bouge : écrire
 * à chaque pixel enverrait cinquante commandes par déplacement, et la carte
 * sauterait de ligne sous le pointeur.
 *
 * Pointer Events et non l'API `draggable` du HTML5, que l'application refuse
 * partout (voir `client/src/nativeDrag.ts`).
 */

/** Ce qu'on tient d'une barre : une extrémité, ou la barre entière. */
export type DragMode = 'start' | 'due' | 'move';

/** Ce qu'un « + » de la barre d'outils fera naître au dépôt. */
export type CreateKind = 'card' | 'milestone';

/** Les dates telles qu'elles seront si on relâche maintenant. */
export interface DatePreview {
    startDate: number | null;
    dueDate: number | null;
}

/** Le geste en cours, tel que la frise le peint. */
export interface DragView {
    /** `null` : un élément à créer, tenu depuis un « + » de la barre d'outils. */
    card: ProjectCard | null;
    /** Ce que le dépôt créera ; `null` quand c'est une carte existante qu'on tient. */
    create: CreateKind | null;
    /** Une pastille en vol, par opposition à une barre déjà posée. */
    placing: boolean;
    /** Ce que le relâchement écrirait ; `null` quand il n'écrirait rien. */
    next: DatePreview | null;
    /** Le pointeur est sur la zone des cartes sans date. */
    overDrop: boolean;
}

interface Options {
    /** Pixels par jour : c'est ce qui convertit un déplacement en durée. */
    dayWidth: number;
    /** Largeur de la fenêtre, en jours : elle borne le jour visé. */
    days: number;
    /** Minuit du premier jour de la fenêtre, en ms. */
    rangeMin: number;
    /** La boîte défilante de la frise : elle dit où un dépôt compte, et d'où partent les abscisses. */
    scrollRef: RefObject<HTMLElement | null>;
    /** La zone des cartes sans date : y lâcher une barre lui retire ses dates. */
    dropRef: RefObject<HTMLElement | null>;
    /** Persiste le geste. Appelé une fois, au relâchement, jamais pendant. */
    onCommit: (card: ProjectCard, startDate: number | null, dueDate: number | null) => void;
    /** Ouvre la création d'une tâche aux dates du dépôt. Même règle : au relâchement seul. */
    onCreate: (startDate: number, dueDate: number) => void;
    /** Ouvre la création d'un jalon à la date du dépôt. */
    onCreateMilestone: (dueDate: number) => void;
    /**
     * Les dates déjà tenues par un jalon, en secondes : un jalon déposé les
     * enjambe, deux traits au même jour se cacheraient l'un l'autre.
     */
    takenMilestoneDates: ReadonlySet<number>;
}

/** En deçà, c'est encore un clic : la carte s'ouvre au lieu de bouger. */
const DRAG_THRESHOLD = 3;

/** Le clic que le navigateur émet au relâchement suit celui-ci de quelques millisecondes. */
const CLICK_AFTER_DRAG_MS = 300;

/** Jusqu'où s'écarter d'un jour occupé pour poser un jalon. */
const FREE_DAY_REACH = 60;

/**
 * Décale une date d'un nombre de jours calendaires, en heure locale, et non de
 * `n × 86 400 s` : les dates du module sont des minuits locaux, qu'un passage à
 * l'heure d'été décalerait d'une heure à chaque fois.
 */
function shiftDays(seconds: number, days: number): number {
    const d = new Date(seconds * 1000);
    d.setDate(d.getDate() + days);
    return Math.floor(d.getTime() / 1000);
}

/**
 * Les dates après un déplacement de `days` jours. Croiser les deux bords ne
 * bloque pas le geste : le `min`/`max` avec l'extrémité fixe décide laquelle
 * devient le début, et la poignée passe de l'autre côté sans qu'on la lâche.
 */
function applyDrag(card: ProjectCard, mode: DragMode, days: number): DatePreview {
    const { startDate, dueDate } = card;

    // Une seule date connue : rien à étirer, l'unique repère se déplace.
    if (startDate === null || dueDate === null) {
        return {
            startDate: startDate === null ? null : shiftDays(startDate, days),
            dueDate: dueDate === null ? null : shiftDays(dueDate, days)
        };
    }

    if (mode === 'move') {
        return { startDate: shiftDays(startDate, days), dueDate: shiftDays(dueDate, days) };
    }

    const moved = mode === 'start' ? shiftDays(startDate, days) : shiftDays(dueDate, days);
    const anchor = mode === 'start' ? dueDate : startDate;
    return { startDate: Math.min(moved, anchor), dueDate: Math.max(moved, anchor) };
}

/**
 * Où l'on vient d'attraper la barre. Les zones de bord sont bornées au tiers de
 * la largeur : sur une barre de deux jours, deux poignées de 10 px ne
 * laisseraient aucun milieu à saisir.
 */
export function modeAt(rect: DOMRect, clientX: number, resizable: boolean): DragMode {
    if (!resizable) return 'move';
    const edge = Math.min(10, rect.width / 3);
    if (clientX - rect.left <= edge) return 'start';
    if (rect.right - clientX <= edge) return 'due';
    return 'move';
}

/** Deux aperçus écriraient-ils la même chose ? Ce qui évite un rendu par pixel. */
function samePreview(a: DatePreview | null, b: DatePreview | null): boolean {
    if (a === null || b === null) return a === b;
    return a.startDate === b.startDate && a.dueDate === b.dueDate;
}

/**
 * La date libre la plus proche du jour visé, en s'écartant d'un jour à la fois,
 * le suivant d'abord : un jalon déposé sur un jour pris se range à côté plutôt
 * que de disparaître sous son voisin. `null` quand tout est pris à portée, ce
 * qui n'arrive qu'avec plus de jalons que de jours de recherche.
 */
function freeDay(first: number, day: number, taken: ReadonlySet<number>): number | null {
    for (let step = 0; step <= FREE_DAY_REACH; step++) {
        for (const at of step === 0
            ? [shiftDays(first, day)]
            : [shiftDays(first, day + step), shiftDays(first, day - step)]) {
            if (!taken.has(at)) return at;
        }
    }
    return null;
}

/** Le pointeur est-il dans cette boîte ? */
function inside(el: HTMLElement | null, clientX: number, clientY: number): boolean {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

export function useDateDrag({
    dayWidth,
    days,
    rangeMin,
    scrollRef,
    dropRef,
    onCommit,
    onCreate,
    onCreateMilestone,
    takenMilestoneDates
}: Options) {
    const [view, setView] = useState<DragView | null>(null);

    /** Le geste en cours. Un `ref` : les écouteurs le lisent hors du rendu. */
    const press = useRef<{
        card: ProjectCard | null;
        /** Ce que le dépôt créera, quand `card` est nul. */
        create: CreateKind | null;
        /** Absent : une pastille ou le « + » qu'on dépose, sans bord à saisir. */
        mode: DragMode | null;
        pointerId: number;
        x: number;
        y: number;
    } | null>(null);
    /** Le seuil a été franchi : le relâchement ne doit plus ouvrir la carte. */
    const moved = useRef(false);
    /**
     * La carte dont le prochain clic est à avaler, `null` valant le « + ». Nommée,
     * et non un simple booléen : une pastille déposée quitte la liste avant que son
     * clic n'arrive, et le drapeau resté levé aurait mangé le clic suivant, sur une
     * tout autre carte.
     */
    const handled = useRef<{ id: number | null; at: number } | null>(null);
    /** L'aperçu courant, pour que le relâchement le persiste sans re-rendu. */
    const latest = useRef<DragView | null>(null);

    // Les valeurs changeantes passent par des `ref` : les cinq écouteurs sont
    // créés une fois pour toutes, comme dans `dragReorder`.
    const opts = useRef({
        dayWidth,
        days,
        rangeMin,
        scrollRef,
        dropRef,
        onCommit,
        onCreate,
        onCreateMilestone,
        takenMilestoneDates
    });
    opts.current = {
        dayWidth,
        days,
        rangeMin,
        scrollRef,
        dropRef,
        onCommit,
        onCreate,
        onCreateMilestone,
        takenMilestoneDates
    };

    const handlers = useRef<{
        move: (e: PointerEvent) => void;
        up: (e: PointerEvent) => void;
        cancel: (e: PointerEvent) => void;
        blur: () => void;
        keydown: (e: KeyboardEvent) => void;
    } | null>(null);

    const end = useCallback(() => {
        const h = handlers.current;
        if (h) {
            window.removeEventListener('pointermove', h.move);
            window.removeEventListener('pointerup', h.up);
            window.removeEventListener('pointercancel', h.cancel);
            window.removeEventListener('blur', h.blur);
            window.removeEventListener('keydown', h.keydown);
        }
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        press.current = null;
        latest.current = null;
        setView(null);
    }, []);

    const endRef = useRef(end);
    endRef.current = end;

    if (handlers.current === null) {
        handlers.current = {
            move: (e) => {
                const p = press.current;
                if (!p || e.pointerId !== p.pointerId) return;
                const { dayWidth: width, days: span, rangeMin: origin, scrollRef: box, dropRef: drop } = opts.current;
                const dx = e.clientX - p.x;
                if (!moved.current) {
                    // Une barre ne part qu'à l'horizontale ; une pastille vient
                    // d'en dessous de la frise, son geste est d'abord vertical.
                    const travel = p.mode === null ? Math.hypot(dx, e.clientY - p.y) : Math.abs(dx);
                    if (travel < DRAG_THRESHOLD) return;
                    moved.current = true;
                    document.body.style.cursor = p.mode === 'move' || p.mode === null ? 'grabbing' : 'ew-resize';
                    document.body.style.userSelect = 'none';
                }

                const overDrop = inside(drop.current, e.clientX, e.clientY);
                const el = box.current;
                let next: DatePreview | null = null;
                if (p.card !== null && p.mode !== null) {
                    next = overDrop
                        ? { startDate: null, dueDate: null }
                        : applyDrag(p.card, p.mode, Math.round(dx / width));
                } else if (el && inside(el, e.clientX, e.clientY)) {
                    // Le jour visé se lit en absolu : la pastille ne vient de
                    // nulle part sur l'axe, un delta n'aurait rien à décaler.
                    // `clientLeft` retire la bordure, `scrollLeft` remet la
                    // frise à son origine quand elle est plus large que sa boîte.
                    const left = el.getBoundingClientRect().left + el.clientLeft - el.scrollLeft;
                    const raw = (e.clientX - left) / width;
                    // Une tâche occupe la case qu'elle survole ; un jalon se peint
                    // sur un trait de la grille, et rejoint donc le plus proche,
                    // sans quoi la moitié droite d'une journée le renverrait au
                    // trait qu'on vient de dépasser. D'où un jour de plus à sa
                    // borne : le dernier trait de la frise est une date visable.
                    const marker = p.create === 'milestone';
                    const aimed = marker ? Math.round(raw) : Math.floor(raw);
                    const day = Math.min(Math.max(aimed, 0), marker ? span : span - 1);
                    const first = Math.floor(startOfDay(origin) / 1000);
                    const at = marker ? freeDay(first, day, opts.current.takenMilestoneDates) : shiftDays(first, day);
                    // `null` : aucune date libre à portée, le dépôt n'écrirait rien.
                    if (at !== null) next = { startDate: at, dueDate: at };
                }

                const held = latest.current;
                if (held && held.overDrop === overDrop && samePreview(held.next, next)) return;
                const shown: DragView = { card: p.card, create: p.create, placing: p.mode === null, next, overDrop };
                latest.current = shown;
                setView(shown);
            },
            up: (e) => {
                const p = press.current;
                if (!p || e.pointerId !== p.pointerId) return;
                const result = moved.current ? latest.current : null;
                const card = p.card;
                if (moved.current) handled.current = { id: card?.id ?? null, at: performance.now() };
                endRef.current();
                // Rien n'a bougé d'un jour entier, ou le lâcher tombe hors de
                // la frise : inutile de réécrire les mêmes dates.
                if (!result?.next) return;
                if (card === null) {
                    // Ce qui n'existe pas encore se pose sur un jour, et sur rien
                    // d'autre : ses deux bords y sont donnés ensemble ou pas du tout.
                    const { startDate, dueDate } = result.next;
                    if (startDate === null || dueDate === null) return;
                    if (p.create === 'milestone') opts.current.onCreateMilestone(dueDate);
                    else opts.current.onCreate(startDate, dueDate);
                    return;
                }
                if (result.next.startDate === card.startDate && result.next.dueDate === card.dueDate) return;
                opts.current.onCommit(card, result.next.startDate, result.next.dueDate);
            },
            cancel: (e) => {
                if (press.current?.pointerId !== e.pointerId) return;
                endRef.current();
            },
            blur: () => endRef.current(),
            keydown: (e) => {
                // Échap abandonne : les dates reviennent à ce qu'elles étaient.
                if (e.key === 'Escape') endRef.current();
            }
        };
    }

    // Un geste ne doit pas survivre à la disparition de la frise (changement
    // d'onglet, popup refermée en plein glissé).
    useEffect(() => () => endRef.current(), []);

    const start = useCallback(
        (e: ReactPointerEvent, card: ProjectCard | null, mode: DragMode | null, create: CreateKind | null = null) => {
            if (e.button !== 0) return;
            const h = handlers.current;
            if (!h) return;
            moved.current = false;
            handled.current = null;
            press.current = { card, create, mode, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
            window.addEventListener('pointermove', h.move);
            window.addEventListener('pointerup', h.up);
            window.addEventListener('pointercancel', h.cancel);
            window.addEventListener('blur', h.blur);
            window.addEventListener('keydown', h.keydown);
        },
        []
    );

    const onBarPointerDown = useCallback(
        (e: ReactPointerEvent, card: ProjectCard, mode: DragMode) => start(e, card, mode),
        [start]
    );
    const onTagPointerDown = useCallback((e: ReactPointerEvent, card: ProjectCard) => start(e, card, null), [start]);
    const onCreatePointerDown = useCallback(
        (e: ReactPointerEvent, kind: CreateKind) => start(e, null, null, kind),
        [start]
    );

    /** Le clic qui suit un glissé n'est pas un clic : il n'ouvre ni la carte ni la création. */
    const consumeClick = useCallback((cardId: number | null) => {
        const last = handled.current;
        handled.current = null;
        // Périssable : la barre change de ligne pendant le geste, le relâchement
        // peut donc tomber à côté d'elle et ne produire aucun clic à consommer.
        // Sans cette limite, c'est le clic suivant, un vrai, qui serait avalé.
        return last !== null && last.id === cardId && performance.now() - last.at < CLICK_AFTER_DRAG_MS;
    }, []);

    return { view, onBarPointerDown, onTagPointerDown, onCreatePointerDown, consumeClick };
}
