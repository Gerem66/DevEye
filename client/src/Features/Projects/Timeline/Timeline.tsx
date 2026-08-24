import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MinimalUser, ProjectCard, ProjectCardDep, ProjectMilestone } from '@deveye/types';
import { Button } from '@/Components';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { useRequestPopupWidth } from '@/stores/popupWidth';
import { Avatar } from '../Board/Avatar';
import { timelineNaturalWidth } from '../Board/width';
import { formatDate } from '../api';
import { DAY_MS, startOfDay, timelineTicks, ZOOM_LEVELS, type ZoomId } from './scale';
import { modeAt, useDateDrag } from './dateDrag';
import styles from '../style.module.css';

/** Hauteur d'une ligne, en px. Fixe : c'est ce qui rend les flèches calculables
 *  sans mesurer le DOM. */
const ROW_H = 34;
const BAR_H = 20;
/**
 * La bande d'en-tête : les étiquettes de dates, puis les jalons dessous.
 *
 * Une seule constante pour les trois couches qui doivent démarrer sous elle (la
 * grille, les flèches de dépendance, les lignes) — c'est ce qui garantit que
 * jalons et barres ne se marchent pas dessus.
 */
const HEAD_H = 44;

/**
 * Étirement maximal, en px par jour.
 *
 * Sur un très grand écran, une fenêtre de quinze jours donnerait sinon des
 * journées de 200 px : les barres deviendraient des banderoles et la lecture n'y
 * gagnerait rien. Le plafond ne se fait sentir que là — la fenêtre fait au moins
 * dix-huit jours (deux semaines plus les marges), donc une popup ordinaire
 * s'occupe entièrement bien avant de l'atteindre.
 */
const MAX_STRETCH_DAY_WIDTH = 96;

/** Rayon des coudes du tracé de dépendance, et repli quand rien ne suit. */
const DEP_RADIUS = 8;
const DEP_GAP = 14;

/**
 * Le tracé d'une dépendance : de la fin du bloqueur au début du bloqué.
 *
 * Trois segments — on sort par la droite, on change de ligne, on entre par la
 * gauche — mais aux coudes arrondis : un angle droit sur un fond quadrillé se
 * confond avec la grille, la courbe se lit comme un chemin.
 *
 * `mid` est l'abscisse du coude et `x2` le bord d'arrivée : les deux sont
 * décidés par l'appelant, qui seul sait par quel côté il vaut mieux entrer.
 * Cette fonction ne fait que tracer — elle accepte aussi bien un coude à gauche
 * du point d'arrivée qu'à sa droite.
 *
 * Le rayon est rogné par la longueur des segments : sur deux lignes voisines,
 * une courbe de 8 px ne tiendrait pas dans les 17 px qui les séparent, et le
 * tracé se replierait sur lui-même.
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
    members: MinimalUser[];
    canWrite: boolean;
    onCardOpen: (card: ProjectCard) => void;
    /** Repose les dates d'une carte après un glissé sur la frise. */
    onCardDates: (card: ProjectCard, startDate: number | null, dueDate: number | null) => void;
    onMilestoneCreate: () => void;
    onMilestoneOpen: (milestone: ProjectMilestone) => void;
}

/**
 * La frise chronologique : les mêmes blocs que le kanban, posés sur le temps.
 *
 * N'y figurent que les cartes **datées** — c'est la demande, et c'est aussi la
 * seule chose qui ait un sens ici. Les autres sont listées dessous plutôt que
 * passées sous silence : une carte invisible est une carte oubliée.
 *
 * Une carte avec deux dates est une barre, une carte n'ayant qu'une échéance
 * est un point : afficher une durée qu'on n'a pas serait une invention.
 */
export function Timeline({
    cards,
    milestones,
    deps,
    members,
    canWrite,
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
     * La largeur réellement offerte à la frise.
     *
     * Mesurée, contrairement à tout le reste de ce fichier : elle ne découle
     * d'aucune donnée, c'est la popup qui la décide. Elle sert uniquement à
     * *étirer* une frise plus courte que sa boîte — jamais à la calculer, ce qui
     * fermerait la boucle (la frise s'élargit, la popup suit, la frise
     * s'élargit…).
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

    // La frise réclame à la popup sa largeur **naturelle** : elle découle de la
    // fenêtre de dates et du zoom, donc changer de zoom fait suivre la popup.
    // Volontairement pas la largeur étirée ci-dessous, qui dépend de la popup —
    // la demande se nourrirait de sa propre réponse.
    useRequestPopupWidth(timelineNaturalWidth(naturalWidth));

    /**
     * Le jour, en pixels, une fois la place disponible prise en compte.
     *
     * Trois tâches sur deux semaines au zoom « Mois » tiennent dans 500 px : la
     * frise se tassait contre le bord gauche d'une popup deux fois plus large,
     * et tout le reste de l'écran ne montrait rien. Quand la fenêtre de dates
     * est plus courte que la boîte, les journées s'élargissent pour l'occuper —
     * jusqu'au plafond, au-delà duquel s'étaler n'apporte plus rien.
     *
     * **Un entier**, et c'est ce qui supprime la barre de défilement fantôme :
     * une largeur de jour fractionnaire donnait une frise large de quelques
     * dixièmes de pixel de trop pour sa boîte, donc un ascenseur horizontal pour
     * rien — et des lignes de grille floues, posées entre deux pixels.
     *
     * Dans l'autre sens, rien ne change : une frise plus longue que sa boîte
     * défile, comme avant.
     */
    const dayWidth = avail > naturalWidth ? Math.min(Math.floor(avail / days), MAX_STRETCH_DAY_WIDTH) : zoomDayWidth;
    const width = days * dayWidth;

    const x = (t: number) => ((t - range.min) / DAY_MS) * dayWidth;
    const ticks = useMemo(() => timelineTicks(range.min, range.max, dayWidth), [range, dayWidth]);

    const rowOf = useMemo(() => new Map(dated.map((c, i) => [c.id, i])), [dated]);

    const { preview, onBarPointerDown, consumeClick } = useDateDrag({ dayWidth, onCommit: onCardDates });

    /**
     * La carte telle qu'elle est **affichée** : ses dates, ou l'aperçu du geste
     * en cours.
     *
     * L'aperçu ne remonte volontairement pas jusqu'à `dated` : l'ordre des
     * lignes reste celui des dates enregistrées, sinon la barre qu'on tient
     * changerait de ligne sous le pointeur dès qu'elle dépasse sa voisine.
     */
    const shown = (card: ProjectCard): ProjectCard =>
        preview?.cardId === card.id ? { ...card, startDate: preview.startDate, dueDate: preview.dueDate } : card;

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
     * L'abscisse du coude des flèches partant d'une tâche.
     *
     * À mi-chemin entre la fin du bloqueur et le début de la **plus proche** des
     * tâches qu'il débloque, parmi celles qui commencent après lui. Une seule
     * valeur pour tout le faisceau : les flèches d'un même bloqueur descendent
     * donc ensemble, et le tronc tombe dans le blanc qui sépare la tâche de sa
     * suite plutôt qu'à une distance arbitraire de son bord.
     *
     * Quand rien ne commence après — toutes les dépendances remontent le temps —
     * il ne reste pas d'intervalle à couper en deux : un écart fixe garde alors
     * le coude visible.
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

    if (dated.length === 0 && milestones.length === 0) {
        return (
            <div className={styles.timelineEmpty}>
                <p className={styles.empty}>
                    Aucune carte datée ni jalon. Posez une date de début ou une échéance sur une carte pour la voir
                    apparaître ici.
                </p>
                {canWrite && (
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
                {canWrite && (
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
                        style={{ height: dated.length * ROW_H + HEAD_H, backgroundSize: `${dayWidth}px 100%` }}
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
                             * Par quel bord entrer chez le bloqué.
                             *
                             * S'il commence **strictement** après la fin du
                             * bloqueur, l'ordre des choses est respecté : on
                             * entre par la gauche, sens de lecture, et le coude
                             * est celui que partagent toutes les flèches du même
                             * bloqueur.
                             *
                             * L'égalité compte pour un chevauchement, et ce n'est
                             * pas un détail : deux tâches qui s'enchaînent au jour
                             * près ont des barres jointives, sans un pixel entre
                             * elles. Le coude n'avait alors nulle part où tomber
                             * et se posait dans la barre visée.
                             *
                             * Dans ces cas-là — début avant, chevauchement ou
                             * jointure — entrer par la gauche obligerait le trait
                             * à revenir en arrière *par-dessus* la barre. On
                             * contourne par la droite : le coude passe au-delà
                             * des deux, et la pointe se pose sur le bord droit du
                             * bloqué. Le trajet ne recouvre alors aucune barre.
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
                            const view = shown(card);
                            const s = spanOf(view);
                            const assignee = members.find((m) => m.id === card.assigneeUserId);
                            const overdue = view.dueDate !== null && view.dueDate * 1000 < Date.now();
                            // Étirable seulement si les deux bouts existent :
                            // un point n'a qu'une date, il se déplace en bloc.
                            const resizable = canWrite && !s.pointOnly;
                            // Les dates dans l'infobulle : après un glissé,
                            // c'est ce qui dit où la barre a atterri sans avoir
                            // à rouvrir la tâche.
                            const period = [formatDate(view.startDate), formatDate(view.dueDate)]
                                .filter(Boolean)
                                .join(' → ');
                            return (
                                <div key={card.id} className={styles.tlRow} style={{ height: ROW_H }}>
                                    <button
                                        type='button'
                                        className={`${styles.bar} ${s.pointOnly ? styles.barPoint : ''} ${
                                            overdue ? styles.barLate : ''
                                        } ${canWrite ? styles.barDraggable : ''}`}
                                        style={{ left: s.left, width: s.width, height: BAR_H }}
                                        onPointerDown={
                                            canWrite
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
                                            if (!consumeClick()) onCardOpen(card);
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
                                        {card.assigneeUserId !== null && <Avatar user={assignee} size={16} />}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {undated.length > 0 && (
                <details className={styles.undated}>
                    <summary>
                        {undated.length} carte{undated.length > 1 ? 's' : ''} sans date
                    </summary>
                    <ul className={styles.undatedList}>
                        {undated.map((card) => (
                            <li key={card.id}>
                                <button type='button' onClick={() => onCardOpen(card)}>
                                    {card.title || 'Sans titre'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

export default Timeline;
