import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, useLiveOutlines, useRequestPopupWidth } from 'deveye-sdk-client';
import { formatDate } from '../api';
import type { ProjectCard, ProjectCardDep, ProjectMilestone } from '../../contracts/domain';
import { MemberStack } from '../Member';
import {
    DAY_LETTER_MIN_WIDTH,
    DAY_LINE_MIN_WIDTH,
    DAY_MS,
    startOfDay,
    timelineTicks,
    WEEKDAY_LETTERS,
    weekdayIndex,
    zoomWindow,
    ZOOM_LEVELS,
    type ZoomId
} from './scale';
import { popupTargetWidth, timelineNaturalWidth } from '../Board/width';
import { modeAt, useDateDrag } from './dateDrag';
import { useScrollLeft, useTimelinePan } from './pan';
import styles from '../style.module.css';

/** Hauteur d'une ligne, en px. Fixe : c'est ce qui rend les flèches calculables
 *  sans mesurer le DOM. */
const ROW_H = 34;
const BAR_H = 20;
/**
 * Hauteur de la bande d'en-tête (dates puis jalons). Une seule constante pour
 * les trois couches qui démarrent sous elle (grille, flèches, lignes) : c'est
 * ce qui empêche jalons et barres de se chevaucher.
 */
const HEAD_H = 44;
/** Hauteur de la bande des jours de la semaine, sous les lignes. */
const DAYS_H = 16;
/** En deçà, la pile d'avatars mangerait le titre de la barre. */
const STACK_MIN_BAR_WIDTH = 56;
/** En deçà, le compte de sous-tâches mangerait le titre de la barre. */
const PROGRESS_MIN_BAR_WIDTH = 104;

/**
 * Les marges de la frise, en jours : une barre posée au bord touche sinon le
 * cadre. La seconde compte le dernier jour pour lui-même.
 */
const PAD_BEFORE = 2;
const PAD_AFTER = 3;

/**
 * Le plancher de la frise, en lignes : elle garde cette hauteur même vide, pour
 * qu'un défilement qui traverse une période creuse ne la fasse pas se replier
 * sur elle-même. Ce n'est qu'un plancher de secours : la frise remplit d'abord
 * la boîte que la fiche lui laisse.
 */
const MIN_ROWS = 5;

/** Le rembourrage vertical de la frise, des deux côtés (`--space-sm`, en dur ici
 * pour que la hauteur des lignes se calcule sans mesurer une variable de thème). */
const INNER_PAD = 8;

/**
 * La part de la hauteur offerte que la frise prend. Le reste est la place de la
 * zone des cartes sans date, qui paraît et disparaît au fil des dépôts : sans
 * cette réserve, la frise se replierait et se rouvrirait sous le pointeur à
 * chaque geste.
 */
const FILL_RATIO = 0.9;

/** Le fantôme d'une tâche à créer : assez large pour que son « + » se lise. */
const CREATE_GHOST_MIN_WIDTH = 24;

/** L'avancement des sous-tâches d'une carte, ou `null` quand elle n'en a pas. */
function progressOf(card: ProjectCard): { done: number; total: number; ratio: number } | null {
    const total = card.checklist.length;
    if (total === 0) return null;
    const done = card.checklist.filter((i) => i.done).length;
    return { done, total, ratio: done / total };
}

/** La date qui range une carte dans la frise : son début, ou son échéance seule. */
function startKey(card: ProjectCard): number {
    return card.startDate ?? card.dueDate ?? 0;
}

/** Rayon des coudes du tracé de dépendance, et repli quand rien ne suit. */
const DEP_RADIUS = 8;
const DEP_GAP = 14;

/**
 * Le tracé d'une dépendance, de la fin du bloqueur au début du bloqué : trois
 * segments aux coudes arrondis, un angle droit se confondant avec la grille.
 *
 * `mid` (l'abscisse du coude) et `x2` (le bord d'arrivée) viennent de
 * l'appelant, seul à savoir par quel côté entrer ; le coude peut donc tomber
 * des deux côtés. Le rayon est rogné par la longueur des segments, sans quoi
 * une courbe de 8 px se replierait entre deux lignes distantes de 17.
 */
function depPath(x1: number, y1: number, x2: number, y2: number, mid: number): string {
    if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} H ${x2}`;

    const dy = Math.sign(y2 - y1);
    const dx = Math.sign(x2 - mid) || 1;
    const r = Math.min(DEP_RADIUS, Math.abs(y2 - y1) / 2, mid - x1, Math.abs(x2 - mid));

    return [
        `M ${x1} ${y1}`,
        `H ${mid - r}`,
        `Q ${mid} ${y1} ${mid} ${y1 + dy * r}`,
        `V ${y2 - dy * r}`,
        `Q ${mid} ${y2} ${mid + dx * r} ${y2}`,
        `H ${x2}`
    ].join(' ');
}

interface TimelineProps {
    /** L'échelle sur laquelle la frise s'ouvre, réglée par le projet. */
    defaultZoom: ZoomId;
    cards: ProjectCard[];
    milestones: ProjectMilestone[];
    deps: ProjectCardDep[];
    /** Tenir les jalons : la planification du projet, sans exception de propriété. */
    canPlan: boolean;
    /** Créer une tâche : le droit de les tenir, et une colonne où la poser. */
    canTasks: boolean;
    /** Les colonnes qui valent « terminé » : leurs tâches se lisent en vert. */
    doneColumnIds: ReadonlySet<number>;
    /** Poser ou retirer les dates de CETTE carte : le droit de planifier, ou elle est sienne. */
    canDate: (card: ProjectCard) => boolean;
    onCardOpen: (card: ProjectCard) => void;
    /** Repose les dates d'une carte après un glissé sur la frise. */
    onCardDates: (card: ProjectCard, startDate: number | null, dueDate: number | null) => void;
    /**
     * Ouvre la création d'une tâche. Les dates viennent d'un dépôt du « + » sur un
     * jour de la frise ; un clic simple ouvre la popup sans rien dater.
     */
    onCardCreate: (dates?: { startDate: number; dueDate: number }) => void;
    /** `dueDate` quand le jalon naît d'un dépôt sur un jour de la frise. */
    onMilestoneCreate: (dueDate?: number) => void;
    onMilestoneOpen: (milestone: ProjectMilestone) => void;
}

/**
 * La frise chronologique : les blocs du kanban posés sur le temps. Seules les
 * cartes datées y figurent, les autres étant listées dessous plutôt que passées
 * sous silence. Deux dates font une barre, une échéance seule fait un point :
 * afficher une durée qu'on n'a pas serait une invention.
 *
 * La liste du bas n'est pas qu'un pense-bête : on en tire une pastille sur un
 * jour pour la dater, et on y ramène une barre pour lui retirer ses dates. Le
 * même geste dans les deux sens, plutôt qu'un aller par la souris et un retour
 * par la popup.
 */
export function Timeline({
    defaultZoom,
    cards,
    milestones,
    deps,
    canPlan,
    canTasks,
    doneColumnIds,
    canDate,
    onCardOpen,
    onCardDates,
    onCardCreate,
    onMilestoneCreate,
    onMilestoneOpen
}: TimelineProps) {
    // Le réglage du projet donne l'échelle d'ouverture ; la barre la change pour
    // le temps de la visite, sans la réécrire.
    const [zoom, setZoom] = useState<ZoomId>(defaultZoom);
    // `l3` : l'onglet du projet occupe `l2` (voir `ProjectDetail`).
    const outlineFor = useLiveOutlines('l3');

    /**
     * La largeur offerte : elle ne découle d'aucune donnée, c'est la popup qui la
     * décide. C'est elle qui déduit la largeur d'un jour de la durée visible,
     * jamais l'inverse, ce qui bouclerait. Celle que la popup VISE et non celle
     * qu'elle a, pour ne pas refaire la fenêtre de temps à chaque image de son
     * élargissement (voir `popupTargetWidth`) : l'observateur dit quand relire, la
     * valeur vient de la cible.
     */
    const scrollRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [avail, setAvail] = useState(0);
    /**
     * La hauteur que la frise s'autorise : ce qui reste sous sa barre d'outils,
     * moins la réserve. Elle se déduit de la boîte de l'onglet et de la position
     * de la frise dedans, jamais de sa hauteur à elle : rien de ce qui grandit
     * avec les lignes n'entre dans le calcul, aucune boucle n'est donc possible.
     */
    const [availHeight, setAvailHeight] = useState(0);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const root = rootRef.current;
        if (!el || !root) return;
        const measure = () => {
            setAvail(popupTargetWidth(el));
            const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
            setAvailHeight(Math.round((root.clientHeight - top) * FILL_RATIO));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        ro.observe(root);
        measure();
        return () => ro.disconnect();
    }, []);

    /** Les cartes posées sur le temps, et celles qui restent à dater. */
    const dated = useMemo(() => cards.filter((c) => c.startDate !== null || c.dueDate !== null), [cards]);
    const undated = useMemo(() => cards.filter((c) => c.startDate === null && c.dueDate === null), [cards]);

    /**
     * Le premier et le dernier jour datés du projet, jalons compris : l'étendue
     * qu'il y a à montrer, `null` quand rien n'est daté. Les dates enregistrées
     * seulement : si l'aperçu d'un glissé y entrait, tirer une barre au-delà du
     * bord redimensionnerait toute la frise sous le pointeur.
     */
    const content = useMemo(() => {
        const points: number[] = [];
        for (const c of dated) {
            if (c.startDate !== null) points.push(c.startDate * 1000);
            if (c.dueDate !== null) points.push(c.dueDate * 1000);
        }
        for (const m of milestones) points.push(m.dueDate * 1000);
        if (points.length === 0) return null;
        return { min: startOfDay(Math.min(...points)), max: startOfDay(Math.max(...points)) };
    }, [dated, milestones]);

    // La popup s'élargit de ce que le projet couvre, et pas d'un pixel de plus :
    // une frise qui tient dans la largeur de confort garde celle des autres onglets.
    const spanDays = content === null ? 0 : Math.round((content.max - content.min) / DAY_MS) + PAD_BEFORE + PAD_AFTER;
    useRequestPopupWidth(timelineNaturalWidth(zoom, spanDays));

    /**
     * Ce que le zoom ouvre : une durée visible, ancrée sur aujourd'hui au tiers,
     * et la largeur de jour qui la fait tenir dans la boîte. Rien ici ne dépend
     * des dates des tâches : « Semaine » montre une semaine, qu'une tâche traîne
     * en septembre ou non.
     */
    const view = useMemo(() => zoomWindow(zoom, avail, Date.now()), [zoom, avail]);

    /**
     * La fenêtre dessinée, en **jours entiers** : celle du zoom, élargie à ce
     * que les tâches et les jalons couvrent, pour qu'on puisse défiler jusqu'à
     * eux. Bornée à minuit des deux côtés, la frise étant une grille de journées :
     * une fenêtre qui s'arrêterait à 14 h 37 décalerait toutes les lignes d'une
     * fraction de jour.
     */
    const range = useMemo(() => {
        const viewEnd = startOfDay(view.start + view.days * DAY_MS);
        const min = Math.min(content?.min ?? view.start, view.start) - PAD_BEFORE * DAY_MS;
        const last = Math.max(content?.max ?? viewEnd, viewEnd);
        const days = Math.round((last - min) / DAY_MS) + PAD_AFTER;
        return { min, days, max: min + days * DAY_MS };
    }, [content, view]);

    const days = range.days;
    const dayWidth = view.dayWidth;
    const width = days * dayWidth;

    const x = (t: number) => ((t - range.min) / DAY_MS) * dayWidth;

    /**
     * La fenêtre du zoom amenée sous les yeux, et elle seule : changer de zoom
     * repose la vue sur aujourd'hui, un défilement à la main la laisse où elle
     * est. La clé retient ce qui a déjà été calé, sinon le moindre re-rendu
     * ramènerait la frise au tiers sous le pointeur.
     */
    const [scrollLeft, syncScroll] = useScrollLeft(scrollRef);
    const anchored = useRef<string | null>(null);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || avail === 0) return;
        const key = `${zoom}:${Math.round(dayWidth)}:${range.min}`;
        if (anchored.current === key) return;
        anchored.current = key;
        el.scrollLeft = Math.max(0, ((view.start - range.min) / DAY_MS) * dayWidth);
        // Relu tout de suite : les lignes tenues se déduisent de la fenêtre
        // visible, que ce calage vient de déplacer.
        syncScroll(el.scrollLeft);
    }, [zoom, dayWidth, avail, view.start, range.min]);

    const ticks = useMemo(() => timelineTicks(range.min, range.max, dayWidth), [range, dayWidth]);

    /** Un jalon par jour : celui qu'on pose enjambe les dates déjà tenues. */
    const milestoneDates = useMemo(() => new Set(milestones.map((m) => m.dueDate)), [milestones]);

    const dropRef = useRef<HTMLDetailsElement>(null);
    const {
        view: drag,
        onBarPointerDown,
        onTagPointerDown,
        onCreatePointerDown,
        consumeClick
    } = useDateDrag({
        dayWidth,
        days,
        rangeMin: range.min,
        scrollRef,
        dropRef,
        onCommit: onCardDates,
        onCreate: (startDate, dueDate) => onCardCreate({ startDate, dueDate }),
        onCreateMilestone: (dueDate) => onMilestoneCreate(dueDate),
        takenMilestoneDates: milestoneDates
    });
    // Saisir le fond de la frise la fait défiler, tant qu'aucun autre geste ne
    // tient le pointeur.
    const pan = useTimelinePan(scrollRef, drag === null);

    /** La pastille en vol : la carte tenue, qui n'a de ligne que sur un jour de la frise. */
    const placing = drag?.placing && drag.card !== null ? drag : null;
    /** Le jour visé par le « + » qu'on promène, en secondes ; `null` hors de la frise. */
    const placingAt = drag?.placing && drag.card === null ? (drag.next?.startDate ?? null) : null;
    /** Le « + Tâche » en vol : il se donne une ligne dans l'ordre du temps. */
    const creating = drag?.create === 'card' ? placingAt : null;
    /** Le « + Jalon » en vol : il se pose dans la bande d'en-tête, comme ses pairs. */
    const creatingMilestone = drag?.create === 'milestone' ? placingAt : null;

    /** Rangée dans une colonne qui vaut « terminé ». */
    const isDone = (card: ProjectCard) => card.columnId !== null && doneColumnIds.has(card.columnId);

    /** La barre tenue est au-dessus de la zone sans date : elle va les perdre. */
    const unplanning = (card: ProjectCard) =>
        drag !== null && !drag.placing && drag.card?.id === card.id && drag.overDrop;

    /**
     * La carte telle qu'affichée : ses dates, ou l'aperçu du geste en cours.
     * Au-dessus de la zone sans date, la barre garde sa place : ce sont ses dates
     * qu'on efface, pas une position qu'on vise.
     */
    const shown = (card: ProjectCard): ProjectCard =>
        drag && drag.card?.id === card.id && drag.next && !drag.overDrop
            ? { ...card, startDate: drag.next.startDate, dueDate: drag.next.dueDate }
            : card;

    /**
     * Les lignes, dans l'ordre du temps, aperçu compris : la barre qu'on tient
     * change de ligne pendant le geste et se trouve à sa place au relâchement.
     */
    const ordered = useMemo(
        () =>
            cards
                .map(shown)
                .filter((c) => c.startDate !== null || c.dueDate !== null)
                .sort((a, b) => startKey(a) - startKey(b) || a.id - b.id),
        [cards, drag]
    );

    /** Le segment occupé par une carte : [début, fin] en px. */
    const spanOf = (card: ProjectCard) => {
        const start = card.startDate !== null ? card.startDate * 1000 : (card.dueDate as number) * 1000;
        const end = card.dueDate !== null ? card.dueDate * 1000 : (card.startDate as number) * 1000;
        const left = x(start);
        // Un jour minimum de largeur : une tâche d'un seul jour doit rester
        // cliquable même au zoom le plus large.
        const right = Math.max(x(end) + dayWidth, left + Math.max(dayWidth, 6));
        return { left, width: right - left, pointOnly: card.startDate === null || card.dueDate === null };
    };

    /** La lettre du jour ne se lit qu'à partir d'une certaine largeur de journée. */
    const dayLetters = dayWidth >= DAY_LETTER_MIN_WIDTH;

    /**
     * Les lignes, et leur nombre : une carte n'en occupe une que si sa barre touche
     * la fenêtre visible. La frise ne fait donc jamais la hauteur de tout le projet,
     * seulement celle de ce qu'elle montre, et une barre qui entre par un bord glisse
     * à sa place au lieu d'y apparaître. Hors champ, une carte prend le rang de sa
     * voisine : c'est de là qu'elle revient.
     *
     * Avant la première mesure, la fenêtre vaut toute la frise : rien ne doit
     * disparaître le temps d'un rendu.
     */
    const seenTo = scrollLeft + (avail || width);
    const rowOf = new Map<number, number>();
    let visibleRows = 0;
    let ghostRow: number | null = null;
    for (const card of ordered) {
        if (creating !== null && ghostRow === null && creating < startKey(card)) ghostRow = visibleRows++;
        rowOf.set(card.id, visibleRows);
        const s = spanOf(card);
        if (s.left < seenTo && s.left + s.width > scrollLeft) visibleRows++;
    }
    if (creating !== null && ghostRow === null) ghostRow = visibleRows++;
    /**
     * Les lignes remplissent la hauteur autorisée : en deçà, la grille s'arrêterait
     * au milieu de la page et laisserait un vide sous elle. Au-delà, c'est le
     * contenu qui commande et la boîte défile.
     */
    const boxRows = Math.floor((availHeight - HEAD_H - (dayLetters ? DAYS_H : 0) - INNER_PAD * 2) / ROW_H);
    const rowsHeight = Math.max(visibleRows, boxRows, MIN_ROWS) * ROW_H;

    /**
     * L'abscisse du coude des flèches partant d'une tâche : à mi-chemin de la
     * plus proche de celles qu'elle débloque. Une seule valeur pour tout le
     * faisceau, si bien que le tronc tombe dans le blanc qui suit la tâche.
     * Quand rien ne commence après elle, un écart fixe garde le coude visible.
     */
    const elbowOf = (blockerId: number, endX: number): number => {
        let nearest = Number.POSITIVE_INFINITY;
        for (const dep of deps) {
            if (dep.blockedByCardId !== blockerId) continue;
            const to = cards.find((c) => c.id === dep.cardId);
            if (!to || !rowOf.has(dep.cardId)) continue;
            const startX = spanOf(shown(to)).left;
            if (startX > endX && startX < nearest) nearest = startX;
        }
        return nearest === Number.POSITIVE_INFINITY ? endX + DEP_GAP : endX + (nearest - endX) / 2;
    };

    // La frise se dessine dès qu'il reste une pastille à y déposer : sans elle,
    // le geste n'aurait nulle part où atterrir.
    if (dated.length === 0 && milestones.length === 0 && undated.length === 0) {
        return (
            <div className={styles.timelineEmpty}>
                <p className={styles.empty}>Aucune carte ni jalon sur ce projet.</p>
                <div className={styles.timelineActions}>
                    {canTasks && (
                        <Button variant='secondary' icon='add' onClick={() => onCardCreate()}>
                            Ajouter une tâche
                        </Button>
                    )}
                    {canPlan && (
                        <Button variant='secondary' icon='add' onClick={() => onMilestoneCreate()}>
                            Ajouter un jalon
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    const now = x(Date.now());

    return (
        <div className={styles.timeline} ref={rootRef}>
            <div className={styles.timelineBar}>
                <div className={styles.zoom}>
                    {ZOOM_LEVELS.map((z) => (
                        <button
                            key={z.id}
                            type='button'
                            className={z.id === zoom ? styles.zoomActive : styles.zoomBtn}
                            onClick={() => setZoom(z.id)}
                        >
                            {z.label}
                        </button>
                    ))}
                </div>
                <div className={styles.timelineActions}>
                    {canTasks && (
                        <Button
                            variant='secondary'
                            icon='add'
                            className={styles.tlAddCard}
                            title='Ajouter une tâche, ou glissez ce bouton sur un jour pour la dater'
                            onPointerDown={(e) => onCreatePointerDown(e, 'card')}
                            onClick={() => {
                                if (!consumeClick(null)) onCardCreate();
                            }}
                        >
                            Tâche
                        </Button>
                    )}
                    {canPlan && (
                        <Button
                            variant='secondary'
                            icon='add'
                            className={styles.tlAddCard}
                            title='Ajouter un jalon, ou glissez ce bouton sur un jour pour le dater'
                            onPointerDown={(e) => onCreatePointerDown(e, 'milestone')}
                            onClick={() => {
                                if (!consumeClick(null)) onMilestoneCreate();
                            }}
                        >
                            Jalon
                        </Button>
                    )}
                </div>
            </div>

            {/* `data-pannable` seulement quand il y a de quoi défiler : un curseur
                de préhension sur une frise qui tient dans sa boîte promet un geste
                sans effet. */}
            <div
                className={styles.timelineScroll}
                ref={scrollRef}
                style={{ maxHeight: availHeight || undefined }}
                data-pannable={width > avail ? '' : undefined}
                data-panning={pan.panning ? '' : undefined}
                onPointerDown={pan.onPointerDown}
            >
                <div className={styles.timelineInner} style={{ width }}>
                    {/* Graduations + jalons : une seule couche de fond, sous les
                        barres. Les lignes quotidiennes sont le fond lui-même —
                        un motif qui se répète tous les `dayWidth` pixels, donc
                        exactement une par jour, sans un nœud de plus. */}
                    <div
                        className={styles.tlGrid}
                        style={
                            {
                                height: rowsHeight + HEAD_H + (dayLetters ? DAYS_H : 0),
                                '--day-w': `${dayWidth}px`,
                                // Sous le plancher, une ligne tous les deux ou
                                // trois pixels ne dessine plus des journées,
                                // elle grise la frise.
                                '--day-line': dayWidth >= DAY_LINE_MIN_WIDTH ? 1 : 0,
                                '--week-shift': -weekdayIndex(range.min)
                            } as CSSProperties
                        }
                    >
                        {ticks.map((tick) => (
                            <div
                                key={tick.t}
                                className={tick.major ? styles.gridLineMajor : styles.gridLine}
                                style={{ left: x(tick.t) }}
                            >
                                <span className={styles.gridLabel}>{tick.label}</span>
                            </div>
                        ))}

                        {now >= 0 && now <= width && <div className={styles.today} style={{ left: now }} />}

                        {milestones.map((m) => (
                            <button
                                key={m.id}
                                type='button'
                                className={m.reachedAt !== null ? styles.milestoneDone : styles.milestone}
                                style={{ left: x(m.dueDate * 1000) }}
                                title={`${m.name || 'Jalon'} : ${new Date(m.dueDate * 1000).toLocaleDateString('fr-FR')}`}
                                onClick={() => onMilestoneOpen(m)}
                            >
                                <span className={`icon icon-star ${styles.milestoneIcon}`} />
                                <span className={styles.milestoneLabel}>{m.name || 'Jalon'}</span>
                            </button>
                        ))}

                        {/* Le jalon qu'on pose, à sa date : en tirets, rien n'est
                            encore écrit. */}
                        {creatingMilestone !== null && (
                            <div className={styles.milestoneGhost} style={{ left: x(creatingMilestone * 1000) }}>
                                <span className={`icon icon-star ${styles.milestoneIcon}`} />
                                <span className={`icon icon-add ${styles.milestoneIcon}`} />
                            </div>
                        )}
                    </div>

                    {/* Les liens de dépendance, au-dessus de la grille et sous
                        les barres : ils partent de la fin du bloqueur et
                        rejoignent le bloqué par le bord qui évite de repasser
                        sur une barre. */}
                    <svg
                        className={styles.depLayer}
                        width={width}
                        height={rowsHeight}
                        // Les marges intérieures de `.timelineInner` comptent :
                        // un élément absolu se cale sur la boîte de marge
                        // intérieure, alors que les lignes, elles, sont dans le
                        // flux et commencent après. Sans ce rattrapage les
                        // flèches passaient `--space-sm` trop haut — elles
                        // touchaient le bord supérieur des barres au lieu d'en
                        // viser le centre. La couche de grille fait de même, par
                        // son `inset`.
                        style={{ top: `calc(var(--space-sm) + ${HEAD_H}px)` }}
                        aria-hidden='true'
                    >
                        {/* Une pointe par état : un marqueur n'hérite pas du
                            `stroke` de son tracé, sa couleur doit être posée
                            avec lui. */}
                        <defs>
                            <marker
                                id='tlDepHead'
                                viewBox='0 0 8 8'
                                refX='7'
                                refY='4'
                                markerWidth='7'
                                markerHeight='7'
                                markerUnits='userSpaceOnUse'
                                orient='auto'
                            >
                                <path d='M 0.5 1 L 7 4 L 0.5 7 Z' className={styles.depHead} />
                            </marker>
                            <marker
                                id='tlDepHeadLate'
                                viewBox='0 0 8 8'
                                refX='7'
                                refY='4'
                                markerWidth='7'
                                markerHeight='7'
                                markerUnits='userSpaceOnUse'
                                orient='auto'
                            >
                                <path d='M 0.5 1 L 7 4 L 0.5 7 Z' className={styles.depHeadLate} />
                            </marker>
                        </defs>

                        {deps.map((dep) => {
                            const from = cards.find((c) => c.id === dep.blockedByCardId);
                            const to = cards.find((c) => c.id === dep.cardId);
                            const fromRow = rowOf.get(dep.blockedByCardId);
                            const toRow = rowOf.get(dep.cardId);
                            if (!from || !to || fromRow === undefined || toRow === undefined) return null;
                            const a = spanOf(shown(from));
                            const b = spanOf(shown(to));
                            // La flèche part toujours de la **fin** du bloqueur :
                            // c'est cet instant-là que la dépendance désigne.
                            const x1 = a.left + a.width;
                            const y1 = fromRow * ROW_H + ROW_H / 2;
                            const y2 = toRow * ROW_H + ROW_H / 2;

                            /*
                             * Par quel bord entrer chez le bloqué : par la
                             * gauche s'il commence STRICTEMENT après la fin du
                             * bloqueur, avec le coude commun au faisceau.
                             *
                             * Sinon (début avant, chevauchement, ou barres
                             * jointives au jour près), entrer par la gauche
                             * ferait revenir le trait par-dessus la barre : on
                             * contourne par la droite, coude au-delà des deux.
                             */
                            const ordered = b.left > x1;
                            const x2 = ordered ? b.left : b.left + b.width;
                            const mid = ordered
                                ? elbowOf(dep.blockedByCardId, x1)
                                : Math.max(x1, b.left + b.width) + DEP_GAP;
                            return (
                                <path
                                    key={`${dep.cardId}-${dep.blockedByCardId}`}
                                    d={depPath(x1, y1, x2, y2, mid)}
                                    className={ordered ? styles.dep : styles.depLate}
                                    markerEnd={`url(#${ordered ? 'tlDepHead' : 'tlDepHeadLate'})`}
                                    fill='none'
                                />
                            );
                        })}
                    </svg>

                    {/* Hors du flux, chacune à sa ligne par une translation : changer
                        d'ordre glisse au lieu de sauter. Rendues par identifiant et
                        non par rang, pour que le nœud d'une barre ne bouge jamais dans
                        l'arbre, ce qui couperait sa transition. */}
                    <div className={styles.rows} style={{ marginTop: HEAD_H, height: rowsHeight }}>
                        {[...ordered]
                            .sort((a, b) => a.id - b.id)
                            .map((at) => {
                                const card = cards.find((c) => c.id === at.id) ?? at;
                                const s = spanOf(at);
                                const rowStyle = {
                                    height: ROW_H,
                                    transform: `translateY(${(rowOf.get(at.id) ?? 0) * ROW_H}px)`
                                };
                                if (placing?.card?.id === at.id) {
                                    return (
                                        <div key={at.id} className={styles.tlRow} style={rowStyle}>
                                            <div
                                                className={styles.barGhost}
                                                style={{ left: s.left, width: dayWidth, height: BAR_H }}
                                            >
                                                <span className={styles.barLabel}>{at.title || 'Sans titre'}</span>
                                            </div>
                                        </div>
                                    );
                                }
                                const done = isDone(card);
                                // Terminée, une échéance dépassée n'est plus un retard.
                                const overdue = !done && at.dueDate !== null && at.dueDate * 1000 < Date.now();
                                const movable = canDate(card);
                                // Étirable seulement si les deux bouts existent :
                                // un point n'a qu'une date, il se déplace en bloc.
                                const resizable = movable && !s.pointOnly;
                                // Les dates dans l'infobulle : après un glissé,
                                // c'est ce qui dit où la barre a atterri sans avoir
                                // à rouvrir la tâche.
                                const period = [formatDate(at.startDate), formatDate(at.dueDate)]
                                    .filter(Boolean)
                                    .join(' → ');
                                const progress = progressOf(card);
                                return (
                                    <div key={at.id} className={styles.tlRow} style={rowStyle}>
                                        <button
                                            type='button'
                                            className={`${styles.bar} ${s.pointOnly ? styles.barPoint : ''} ${
                                                overdue ? styles.barLate : ''
                                            } ${done ? styles.barDone : ''} ${movable ? styles.barDraggable : ''} ${
                                                unplanning(card) ? styles.barLeaving : ''
                                            }`}
                                            style={{ left: s.left, width: s.width, height: BAR_H }}
                                            onPointerDown={
                                                movable
                                                    ? (e) =>
                                                          onBarPointerDown(
                                                              e,
                                                              card,
                                                              modeAt(
                                                                  e.currentTarget.getBoundingClientRect(),
                                                                  e.clientX,
                                                                  resizable
                                                              )
                                                          )
                                                    : undefined
                                            }
                                            // Le clic qui clôt un glissé n'ouvre pas
                                            // la carte : on vient de poser des dates,
                                            // pas de demander à les lire.
                                            onClick={() => {
                                                if (!consumeClick(card.id)) onCardOpen(card);
                                            }}
                                            title={[
                                                period
                                                    ? `${card.title || 'Sans titre'} : ${period}`
                                                    : card.title || 'Sans titre',
                                                progress ? `${progress.done} / ${progress.total} sous-tâches` : ''
                                            ]
                                                .filter(Boolean)
                                                .join('\n')}
                                            {...outlineFor(`card:${card.id}`)}
                                        >
                                            {/* Deux lisières, là seulement pour le
                                                curseur : le mode est décidé par la
                                                position du pointeur, pas par la
                                                cible de l'événement. */}
                                            {resizable && (
                                                <>
                                                    <span className={styles.barGripStart} aria-hidden='true' />
                                                    <span className={styles.barGripEnd} aria-hidden='true' />
                                                </>
                                            )}
                                            {/* Le remplissage de l'avancement, sous le
                                                contenu : d'un coup d'oeil, la part
                                                des sous-tâches faites. */}
                                            {progress && (
                                                <span
                                                    className={styles.barFill}
                                                    style={{ width: `${progress.ratio * 100}%` }}
                                                    aria-hidden='true'
                                                />
                                            )}
                                            <span className={styles.barLabel}>{card.title || 'Sans titre'}</span>
                                            {progress && s.width >= PROGRESS_MIN_BAR_WIDTH && (
                                                <span className={styles.barCount}>
                                                    {progress.done} / {progress.total}
                                                </span>
                                            )}
                                            {s.width >= STACK_MIN_BAR_WIDTH && (
                                                <MemberStack
                                                    userId={card.assigneeUserId}
                                                    others={card.checklist.map((i) => i.assigneeUserId)}
                                                    size={16}
                                                    max={3}
                                                />
                                            )}
                                        </button>
                                    </div>
                                );
                            })}

                        {/* La tâche qu'on pose : à sa ligne comme les autres, pour
                            qu'on voie où elle tombera dans l'ordre du temps. */}
                        {creating !== null && ghostRow !== null && (
                            <div
                                className={styles.tlRow}
                                style={{ height: ROW_H, transform: `translateY(${ghostRow * ROW_H}px)` }}
                            >
                                <div
                                    className={styles.barGhostNew}
                                    style={{
                                        left: x(creating * 1000),
                                        width: Math.max(dayWidth, CREATE_GHOST_MIN_WIDTH),
                                        height: BAR_H
                                    }}
                                >
                                    <span className='icon icon-add' />
                                </div>
                            </div>
                        )}
                    </div>

                    {dayLetters && (
                        <DayLetters
                            scrollLeft={scrollLeft}
                            rangeMin={range.min}
                            days={days}
                            dayWidth={dayWidth}
                            viewport={avail}
                        />
                    )}
                </div>
            </div>

            {/* La zone reste rendue pendant qu'on tient une barre, même vide :
                c'est la cible du geste de retour, elle doit exister avant qu'on
                y arrive. */}
            {(undated.length > 0 || (drag !== null && !drag.placing)) && (
                <details
                    ref={dropRef}
                    className={`${styles.undated} ${drag?.overDrop ? styles.undatedOver : ''}`}
                    // Constante : React ne retouche donc jamais l'attribut, et un
                    // repli à la main tient, y compris en plein geste.
                    open
                >
                    <summary>
                        {drag !== null && !drag.placing
                            ? 'Déposer ici pour retirer les dates'
                            : undated.length === 1
                              ? '1 carte sans date : glissez-la sur la frise pour la dater'
                              : `${undated.length} cartes sans date : glissez-en une sur la frise pour la dater`}
                    </summary>
                    <ul className={styles.undatedList}>
                        {undated.map((card) => {
                            const movable = canDate(card);
                            return (
                                <li key={card.id}>
                                    <button
                                        type='button'
                                        className={`${movable ? styles.tagDraggable : ''} ${
                                            isDone(card) ? styles.tagDone : ''
                                        } ${placing?.card?.id === card.id ? styles.tagDragging : ''}`}
                                        title={
                                            movable
                                                ? `${card.title || 'Sans titre'} : glissez-la sur la frise pour la dater`
                                                : card.title || 'Sans titre'
                                        }
                                        onPointerDown={movable ? (e) => onTagPointerDown(e, card) : undefined}
                                        onClick={() => {
                                            if (!consumeClick(card.id)) onCardOpen(card);
                                        }}
                                    >
                                        {card.title || 'Sans titre'}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </details>
            )}
        </div>
    );
}

interface DayLettersProps {
    /** Le défilement de la frise, d'où se déduisent les jours à écrire. */
    scrollLeft: number;
    rangeMin: number;
    days: number;
    dayWidth: number;
    /** Largeur visible de la frise. */
    viewport: number;
}

/** La lettre de chaque jour, sous les lignes. Seuls les jours à l'écran sont rendus. */
function DayLetters({ scrollLeft, rangeMin, days, dayWidth, viewport }: DayLettersProps) {
    // Par addition sur le rang du premier jour, jamais par une date par jour : un
    // changement d'heure décalerait d'un cran les lettres qui le suivent.
    const baseDow = weekdayIndex(rangeMin);
    const today = Math.round((startOfDay(Date.now()) - rangeMin) / DAY_MS);
    const first = Math.max(0, Math.floor(scrollLeft / dayWidth) - 1);
    const last = Math.min(days - 1, Math.ceil((scrollLeft + viewport) / dayWidth) + 1);

    const letters = [];
    for (let i = first; i <= last; i++) {
        const dow = (baseDow + i) % 7;
        letters.push(
            <span
                key={i}
                className={i === today ? styles.tlDayToday : dow >= 5 ? styles.tlDayOff : styles.tlDay}
                style={{ left: i * dayWidth, width: dayWidth }}
            >
                {WEEKDAY_LETTERS[dow]}
            </span>
        );
    }
    return (
        <div className={styles.tlDays} style={{ height: DAYS_H }} aria-hidden='true'>
            {letters}
        </div>
    );
}

export default Timeline;
