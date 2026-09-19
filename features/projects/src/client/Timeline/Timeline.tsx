import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, useLiveOutlines, useRequestPopupWidth } from 'deveye-sdk-client';
import { formatDate } from '../api';
import type { ProjectCard, ProjectCardDep, ProjectMilestone } from '../../contracts/domain';
import { MemberAvatar } from '../Member';
import { timelineNaturalWidth } from '../Board/width';
import { DAY_MS, startOfDay, timelineTicks, ZOOM_LEVELS, type ZoomId } from './scale';
import { modeAt, useDateDrag } from './dateDrag';
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

/**
 * Étirement maximal, en px par jour : sans plafond, une fenêtre courte sur un
 * grand écran donnerait des journées de 200 px et des barres illisibles. Une
 * popup ordinaire remplit sa largeur bien avant de l'atteindre.
 */
const MAX_STRETCH_DAY_WIDTH = 96;

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
    cards: ProjectCard[];
    milestones: ProjectMilestone[];
    deps: ProjectCardDep[];
    /** Tenir les jalons : la planification du projet, sans exception de propriété. */
    canPlan: boolean;
    /** Poser ou retirer les dates de CETTE carte : le droit de planifier, ou elle est sienne. */
    canDate: (card: ProjectCard) => boolean;
    onCardOpen: (card: ProjectCard) => void;
    /** Repose les dates d'une carte après un glissé sur la frise. */
    onCardDates: (card: ProjectCard, startDate: number | null, dueDate: number | null) => void;
    onMilestoneCreate: () => void;
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
    cards,
    milestones,
    deps,
    canPlan,
    canDate,
    onCardOpen,
    onCardDates,
    onMilestoneCreate,
    onMilestoneOpen
}: TimelineProps) {
    const [zoom, setZoom] = useState<ZoomId>('month');
    const zoomDayWidth = ZOOM_LEVELS.find((z) => z.id === zoom)?.dayWidth ?? 10;
    // `l3` : l'onglet du projet occupe `l2` (voir `ProjectDetail`).
    const outlineFor = useLiveOutlines('l3');

    /**
     * La largeur offerte, mesurée : elle ne découle d'aucune donnée, c'est la
     * popup qui la décide. Elle sert à étirer une frise plus courte que sa
     * boîte, jamais à la calculer, ce qui bouclerait.
     */
    const scrollRef = useRef<HTMLDivElement>(null);
    const [avail, setAvail] = useState(0);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => setAvail(entry.contentRect.width));
        ro.observe(el);
        setAvail(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    const dated = useMemo(
        () =>
            cards
                .filter((c) => c.startDate !== null || c.dueDate !== null)
                .sort((a, b) => (a.startDate ?? a.dueDate ?? 0) - (b.startDate ?? b.dueDate ?? 0)),
        [cards]
    );
    const undated = useMemo(() => cards.filter((c) => c.startDate === null && c.dueDate === null), [cards]);

    /**
     * La fenêtre couverte, en **jours entiers**.
     *
     * Bornée à minuit des deux côtés : la frise est une grille de journées, une
     * fenêtre qui s'arrêterait à 14 h 37 (l'instant du dernier point) décalerait
     * toutes les lignes d'une fraction de jour et rendrait la dernière colonne
     * plus étroite que les autres, sans raison lisible.
     */
    const range = useMemo(() => {
        const points: number[] = [];
        for (const c of dated) {
            if (c.startDate !== null) points.push(c.startDate * 1000);
            if (c.dueDate !== null) points.push(c.dueDate * 1000);
        }
        for (const m of milestones) points.push(m.dueDate * 1000);
        points.push(Date.now());
        // Deux jours de marge à gauche, trois à droite (le dernier jour compte
        // pour lui-même). Au moins dix-huit jours en tout, sinon une frise à une
        // seule carte s'écrase sur un trait.
        const min = startOfDay(Math.min(...points)) - 2 * DAY_MS;
        const last = startOfDay(Math.max(...points));
        const days = Math.max(Math.round((last - min) / DAY_MS) + 3, 18);
        return { min, days, max: min + days * DAY_MS };
    }, [dated, milestones]);

    const days = range.days;
    /** Ce que le zoom choisi réclame, indépendamment de la place disponible. */
    const naturalWidth = days * zoomDayWidth;

    // La largeur NATURELLE, tirée de la fenêtre et du zoom : changer de zoom
    // fait suivre la popup. Jamais la largeur étirée, qui dépend de la popup et
    // ferait boucler la demande sur sa réponse.
    useRequestPopupWidth(timelineNaturalWidth(naturalWidth));

    /**
     * Le jour en pixels, place disponible comprise : une fenêtre plus courte que
     * la boîte étire ses journées pour l'occuper, jusqu'au plafond ; une frise
     * plus longue défile.
     *
     * Un entier, sans quoi la frise dépasse sa boîte de quelques dixièmes de
     * pixel (ascenseur horizontal fantôme) et les lignes de grille tombent
     * entre deux pixels.
     */
    const dayWidth = avail > naturalWidth ? Math.min(Math.floor(avail / days), MAX_STRETCH_DAY_WIDTH) : zoomDayWidth;
    const width = days * dayWidth;

    const x = (t: number) => ((t - range.min) / DAY_MS) * dayWidth;
    const ticks = useMemo(() => timelineTicks(range.min, range.max, dayWidth), [range, dayWidth]);

    const rowOf = useMemo(() => new Map(dated.map((c, i) => [c.id, i])), [dated]);

    const dropRef = useRef<HTMLDetailsElement>(null);
    const {
        view: drag,
        onBarPointerDown,
        onTagPointerDown,
        consumeClick
    } = useDateDrag({
        dayWidth,
        days,
        rangeMin: range.min,
        scrollRef,
        dropRef,
        onCommit: onCardDates
    });
    /** La pastille en vol : la carte tenue, et le jour sous le pointeur s'il y en a un. */
    const placing = drag?.placing ? drag : null;
    const ghostAt = placing?.next?.startDate ?? null;
    /** La barre tenue est au-dessus de la zone sans date : elle va les perdre. */
    const unplanning = (card: ProjectCard) =>
        drag !== null && !drag.placing && drag.card.id === card.id && drag.overDrop;

    /**
     * La carte telle qu'affichée : ses dates, ou l'aperçu du geste en cours.
     * L'aperçu ne remonte pas jusqu'à `dated`, sinon la barre qu'on tient
     * changerait de ligne dès qu'elle dépasse sa voisine. Au-dessus de la zone
     * sans date, la barre garde sa place : ce sont ses dates qu'on efface, pas
     * une position qu'on vise.
     */
    const shown = (card: ProjectCard): ProjectCard =>
        drag && !drag.placing && drag.card.id === card.id && drag.next && !drag.overDrop
            ? { ...card, startDate: drag.next.startDate, dueDate: drag.next.dueDate }
            : card;

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
                <p className={styles.empty}>
                    Aucune carte ni jalon. Créez une tâche dans le tableau pour la placer ici.
                </p>
                {canPlan && (
                    <Button variant='secondary' icon='add' onClick={onMilestoneCreate}>
                        Ajouter un jalon
                    </Button>
                )}
            </div>
        );
    }

    const now = x(Date.now());

    return (
        <div className={styles.timeline}>
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
                {canPlan && (
                    <Button variant='secondary' icon='add' onClick={onMilestoneCreate}>
                        Jalon
                    </Button>
                )}
            </div>

            <div className={styles.timelineScroll} ref={scrollRef}>
                <div className={styles.timelineInner} style={{ width }}>
                    {/* Graduations + jalons : une seule couche de fond, sous les
                        barres. Les lignes quotidiennes sont le fond lui-même —
                        un motif qui se répète tous les `dayWidth` pixels, donc
                        exactement une par jour, sans un nœud de plus. */}
                    <div
                        className={styles.tlGrid}
                        style={{
                            height: (dated.length + (ghostAt !== null ? 1 : 0)) * ROW_H + HEAD_H,
                            backgroundSize: `${dayWidth}px 100%`
                        }}
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
                                title={`${m.name || 'Jalon'} — ${new Date(m.dueDate * 1000).toLocaleDateString('fr-FR')}`}
                                onClick={() => onMilestoneOpen(m)}
                            >
                                <span className={`icon icon-star ${styles.milestoneIcon}`} />
                                <span className={styles.milestoneLabel}>{m.name || 'Jalon'}</span>
                            </button>
                        ))}
                    </div>

                    {/* Les liens de dépendance, au-dessus de la grille et sous
                        les barres : ils partent de la fin du bloqueur et
                        rejoignent le bloqué par le bord qui évite de repasser
                        sur une barre. */}
                    <svg
                        className={styles.depLayer}
                        width={width}
                        height={dated.length * ROW_H}
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

                    <div className={styles.rows} style={{ marginTop: HEAD_H }}>
                        {dated.map((card) => {
                            const at = shown(card);
                            const s = spanOf(at);
                            const overdue = at.dueDate !== null && at.dueDate * 1000 < Date.now();
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
                            return (
                                <div key={card.id} className={styles.tlRow} style={{ height: ROW_H }}>
                                    <button
                                        type='button'
                                        className={`${styles.bar} ${s.pointOnly ? styles.barPoint : ''} ${
                                            overdue ? styles.barLate : ''
                                        } ${movable ? styles.barDraggable : ''} ${
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
                                        title={period ? `${card.title || 'Sans titre'} — ${period}` : card.title}
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
                                        <span className={styles.barLabel}>{card.title || 'Sans titre'}</span>
                                        {card.assigneeUserId !== null && (
                                            <MemberAvatar userId={card.assigneeUserId} size={16} />
                                        )}
                                    </button>
                                </div>
                            );
                        })}

                        {/* La pastille en vol, dans une ligne de plus ajoutée en
                            fin : l'insérer à son rang la ferait sauter de ligne
                            sous le pointeur, le rang se décidant sur la date. */}
                        {placing && ghostAt !== null && (
                            <div className={styles.tlRow} style={{ height: ROW_H }}>
                                <div
                                    className={styles.barGhost}
                                    style={{ left: x(ghostAt * 1000), width: dayWidth, height: BAR_H }}
                                >
                                    <span className={styles.barLabel}>{placing.card.title || 'Sans titre'}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* La zone reste rendue pendant qu'on tient une barre, même vide :
                c'est la cible du geste de retour, elle doit exister avant qu'on
                y arrive. */}
            {(undated.length > 0 || (drag !== null && !drag.placing)) && (
                <details
                    ref={dropRef}
                    className={`${styles.undated} ${drag?.overDrop ? styles.undatedOver : ''}`}
                    open={undated.length === 0 ? true : undefined}
                >
                    <summary>
                        {drag !== null && !drag.placing
                            ? 'Déposer ici pour retirer les dates'
                            : `${undated.length} carte${undated.length > 1 ? 's' : ''} sans date`}
                    </summary>
                    <ul className={styles.undatedList}>
                        {undated.map((card) => {
                            const movable = canDate(card);
                            return (
                                <li key={card.id}>
                                    <button
                                        type='button'
                                        className={`${movable ? styles.tagDraggable : ''} ${
                                            placing?.card.id === card.id ? styles.tagDragging : ''
                                        }`}
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

export default Timeline;
