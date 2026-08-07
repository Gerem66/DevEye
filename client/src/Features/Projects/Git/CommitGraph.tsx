import { useMemo, useState, type MouseEvent } from 'react';
import type { ProjectCommitAuthor, ProjectCommitPoint } from 'deveye-types';
import { userColorVar } from '@/Features/Profile/userColors';
import { DAY_MS, startOfDay, timelineTicks } from '../Timeline/scale';
import { useElementWidth } from './useElementWidth';
import styles from '../style.module.css';

const HEIGHT = 230;
/** Marges : la gauche loge les heures, le bas les dates. */
const PAD = { left: 44, right: 14, top: 12, bottom: 26 };
const DOT_R = 3.2;
/** Rayon de capture du survol et du clic, en px. */
const PICK_R = 14;
/** Graduations horaires : le quart de journée se lit sans compter. */
const HOUR_TICKS = [0, 6, 12, 18, 24];

interface CommitGraphProps {
    points: ProjectCommitPoint[];
    authors: ProjectCommitAuthor[];
    firstCommitAt: number | null;
    lastCommitAt: number | null;
    total: number;
    /** Ouvre le détail d'un commit ; absent = graphe non cliquable. */
    onOpenCommit?: (sha: string) => void;
}

/**
 * Tous les commits dans le temps : un point par commit, coloré par auteur.
 *
 * **Les deux axes portent une grandeur réelle** — c'est ce qui a changé, et ce
 * qui compte. L'ordonnée était auparavant un brouillage dérivé du sha : il
 * dispersait bien les points d'une même journée, mais alignait sans le vouloir
 * des colonnes verticales qui ne disaient rien. Elle porte désormais **l'heure
 * de la journée**. La dispersion est la même — deux commits du même jour tombent
 * rarement à la même heure — mais elle veut enfin dire quelque chose : on lit
 * d'un coup d'œil les nuits blanches, les journées ouvrées, les week-ends.
 *
 * Pixels réels et non `viewBox` étiré : voir `useElementWidth`. Un disque étiré
 * n'est plus un disque.
 *
 * SVG à la main, comme `Features/Monitoring/MiniGraph.tsx` et
 * `Features/Uptime/UptimeChart.tsx` — il n'y a aucune bibliothèque de graphes
 * dans ce dépôt, et en ajouter une pour dessiner des ronds serait disproportionné.
 */
export function CommitGraph({ points, authors, firstCommitAt, lastCommitAt, total, onOpenCommit }: CommitGraphProps) {
    const [highlight, setHighlight] = useState<string | null>(null);
    const [hover, setHover] = useState<{ point: ProjectCommitPoint; x: number; y: number } | null>(null);
    const [boxRef, width] = useElementWidth<HTMLDivElement>();

    const authorOf = useMemo(() => new Map(authors.map((a) => [a.authorRef, a])), [authors]);

    /** Bornes de la fenêtre, arrondies au jour : les graduations tombent juste. */
    const range = useMemo(() => {
        if (firstCommitAt === null || lastCommitAt === null) return null;
        const min = startOfDay(firstCommitAt * 1000);
        // Au moins une journée de fenêtre, sinon un dépôt d'un seul jour
        // diviserait par zéro.
        const max = Math.max(startOfDay(lastCommitAt * 1000) + DAY_MS, min + DAY_MS);
        return { min, max };
    }, [firstCommitAt, lastCommitAt]);

    /**
     * Les points en pixels, calculés une fois.
     *
     * L'abscisse est la date, l'ordonnée l'heure locale : minuit en haut, minuit
     * suivant en bas — l'ordre de lecture d'une journée.
     */
    const placed = useMemo(() => {
        if (!range || width <= 0) return [];
        const plotW = Math.max(1, width - PAD.left - PAD.right);
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const span = range.max - range.min;
        return points.map((point) => {
            const at = point.committedAt * 1000;
            const date = new Date(at);
            const hour = date.getHours() + date.getMinutes() / 60;
            return {
                point,
                x: PAD.left + ((at - range.min) / span) * plotW,
                y: PAD.top + (hour / 24) * plotH
            };
        });
    }, [points, range, width]);

    const ticks = useMemo(() => {
        if (!range || width <= 0) return [];
        const plotW = Math.max(1, width - PAD.left - PAD.right);
        const days = (range.max - range.min) / DAY_MS;
        return timelineTicks(range.min, range.max, plotW / days);
    }, [range, width]);

    if (points.length === 0 || !range) {
        return <p className={styles.empty}>Aucun commit synchronisé pour l’instant.</p>;
    }

    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - range.min) / (range.max - range.min)) * plotW;
    const yHour = (hour: number) => PAD.top + (hour / 24) * plotH;

    /**
     * Le point le plus proche du curseur.
     *
     * Un seul écouteur sur le SVG plutôt qu'un par disque : à quelques milliers
     * de commits, autant de gestionnaires coûteraient bien plus cher que ce
     * balayage.
     */
    const pick = (e: MouseEvent<SVGSVGElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let best: (typeof placed)[number] | null = null;
        let bestDist = PICK_R * PICK_R;
        for (const item of placed) {
            // Un auteur mis en avant capture seul : cliquer « à travers » les
            // points estompés donnerait un commit qu'on ne voit pas.
            if (highlight !== null && item.point.authorRef !== highlight) continue;
            const dx = item.x - px;
            const dy = item.y - py;
            const dist = dx * dx + dy * dy;
            if (dist <= bestDist) {
                bestDist = dist;
                best = item;
            }
        }
        return best;
    };

    const fmtDay = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const fmtRange = (t: number) => new Date(t * 1000).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });

    const hovered = hover ? authorOf.get(hover.point.authorRef) : undefined;

    return (
        <div className={styles.graphWrap}>
            <div className={styles.graphHead}>
                <span>
                    {total} commit{total > 1 ? 's' : ''}
                    {/* Le serveur borne les points transportés : quand il en manque,
                        on le dit plutôt que de laisser croire à un dépôt plus petit. */}
                    {points.length < total && ` · ${points.length} affichés`}
                </span>
                <span className={styles.graphRange}>
                    {firstCommitAt !== null && lastCommitAt !== null && (
                        <>
                            {fmtRange(firstCommitAt)} → {fmtRange(lastCommitAt)}
                        </>
                    )}
                </span>
            </div>

            <div className={styles.graphBox} ref={boxRef}>
                {width > 0 && (
                    <svg
                        className={styles.graph}
                        width={width}
                        height={HEIGHT}
                        role='img'
                        aria-label={`Graphe de ${total} commits, par date et heure de la journée`}
                        onMouseMove={(e) => {
                            const best = pick(e);
                            setHover(best ? { point: best.point, x: best.x, y: best.y } : null);
                        }}
                        onMouseLeave={() => setHover(null)}
                        onClick={(e) => {
                            const best = pick(e);
                            if (best && onOpenCommit) onOpenCommit(best.point.sha);
                        }}
                        style={{ cursor: hover && onOpenCommit ? 'pointer' : 'default' }}
                    >
                        {/* Heures : la trame de fond, sous tout le reste. */}
                        {HOUR_TICKS.map((hour) => (
                            <g key={hour}>
                                <line
                                    x1={PAD.left}
                                    x2={width - PAD.right}
                                    y1={yHour(hour)}
                                    y2={yHour(hour)}
                                    className={hour === 0 || hour === 24 ? styles.graphAxis : styles.graphGrid}
                                />
                                <text
                                    x={PAD.left - 8}
                                    y={yHour(hour)}
                                    className={styles.graphLabel}
                                    textAnchor='end'
                                    dominantBaseline='middle'
                                >
                                    {String(hour).padStart(2, '0')}h
                                </text>
                            </g>
                        ))}

                        {/* Dates : graduations partagées avec la frise du projet. */}
                        {ticks.map((tick) => (
                            <g key={tick.t}>
                                <line
                                    x1={x(tick.t)}
                                    x2={x(tick.t)}
                                    y1={PAD.top}
                                    y2={HEIGHT - PAD.bottom}
                                    className={tick.major ? styles.graphGridMajor : styles.graphGrid}
                                />
                                <text
                                    x={x(tick.t)}
                                    y={HEIGHT - PAD.bottom + 15}
                                    className={styles.graphLabel}
                                    textAnchor='middle'
                                >
                                    {tick.label}
                                </text>
                            </g>
                        ))}

                        {placed.map((item) => {
                            const dim = highlight !== null && item.point.authorRef !== highlight;
                            return (
                                <circle
                                    key={item.point.sha}
                                    cx={item.x}
                                    cy={item.y}
                                    r={DOT_R}
                                    fill={userColorVar(authorOf.get(item.point.authorRef)?.color ?? 'blue')}
                                    // framer-motion n'intervient pas ici, mais on
                                    // reste sur `filter` par cohérence avec le
                                    // reste du module.
                                    style={{ filter: dim ? 'opacity(0.1)' : 'opacity(0.85)' }}
                                />
                            );
                        })}

                        {hover && <circle cx={hover.x} cy={hover.y} r={DOT_R + 3} className={styles.graphHalo} />}
                    </svg>
                )}

                {hover && (
                    <div
                        className={styles.graphTip}
                        style={{
                            // Bascule à gauche près du bord droit, sinon l'info-bulle
                            // sortirait de la boîte.
                            left: hover.x > width - 190 ? undefined : hover.x + 12,
                            right: hover.x > width - 190 ? width - hover.x + 12 : undefined,
                            top: Math.max(0, hover.y - 8)
                        }}
                    >
                        <code>{hover.point.sha.slice(0, 7)}</code>
                        <span>{hovered?.name || hovered?.email || 'Auteur inconnu'}</span>
                        <span className={styles.hint}>
                            {fmtDay(hover.point.committedAt * 1000)}
                            {' · '}
                            {new Date(hover.point.committedAt * 1000).toLocaleTimeString('fr-FR', {
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                        </span>
                    </div>
                )}
            </div>

            <ul className={styles.legend}>
                {authors
                    .slice()
                    .sort((a, b) => b.commitCount - a.commitCount)
                    .map((author) => (
                        <li key={author.authorRef}>
                            <button
                                type='button'
                                className={highlight === author.authorRef ? styles.legendOn : styles.legendItem}
                                onMouseEnter={() => setHighlight(author.authorRef)}
                                onMouseLeave={() => setHighlight(null)}
                                onClick={() => setHighlight(highlight === author.authorRef ? null : author.authorRef)}
                            >
                                <span className={styles.legendDot} style={{ background: userColorVar(author.color) }} />
                                {author.name || author.email || 'Auteur inconnu'}
                                <span className={styles.legendCount}>{author.commitCount}</span>
                            </button>
                        </li>
                    ))}
            </ul>
        </div>
    );
}

export default CommitGraph;
