import { useMemo, useState } from 'react';
import type { ProjectCommitAuthor, ProjectCommitPoint } from 'deveye-types';
import { userColorVar } from '@/Features/Profile/userColors';
import styles from '../style.module.css';

const HEIGHT = 200;
const PAD_X = 16;
const PAD_Y = 18;
const DOT_R = 2.6;

interface CommitGraphProps {
    points: ProjectCommitPoint[];
    authors: ProjectCommitAuthor[];
    firstCommitAt: number | null;
    lastCommitAt: number | null;
    total: number;
}

/**
 * Tous les commits dans le temps : un point par commit, du premier au dernier,
 * coloré par auteur.
 *
 * SVG à la main, comme `Features/Monitoring/MiniGraph.tsx` et
 * `Features/Uptime/UptimeChart.tsx` — il n'y a aucune bibliothèque de graphes
 * dans ce dépôt, et en ajouter une pour dessiner des ronds serait disproportionné.
 *
 * La **hauteur d'un point est un brouillage déterministe** dérivé de son sha :
 * sans lui, cent commits du même jour se superposeraient en un seul point ; avec
 * un aléa réel, le graphe frémirait à chaque rendu. Le sha donne les deux —
 * dispersion et stabilité.
 */
export function CommitGraph({ points, authors, firstCommitAt, lastCommitAt, total }: CommitGraphProps) {
    const [highlight, setHighlight] = useState<string | null>(null);

    const colorOf = useMemo(() => {
        const map = new Map(authors.map((a) => [a.authorRef, userColorVar(a.color)]));
        return (ref: string) => map.get(ref) ?? 'var(--text-muted)';
    }, [authors]);

    if (points.length === 0 || firstCommitAt === null || lastCommitAt === null) {
        return <p className={styles.empty}>Aucun commit synchronisé pour l’instant.</p>;
    }

    // Un dépôt dont tous les commits tombent le même jour ne doit pas diviser
    // par zéro : on lui donne une fenêtre d'un jour.
    const span = Math.max(lastCommitAt - firstCommitAt, 86_400);
    const width = 100; // pourcentage : le SVG s'étire, les points restent relatifs
    const x = (t: number) => PAD_X + ((t - firstCommitAt) / span) * (1000 - 2 * PAD_X);

    const yOf = (sha: string) => {
        let h = 0;
        for (let i = 0; i < sha.length; i++) h = (h * 31 + sha.charCodeAt(i)) % 10007;
        return PAD_Y + (h / 10007) * (HEIGHT - 2 * PAD_Y);
    };

    const fmt = (t: number) => new Date(t * 1000).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });

    return (
        <div className={styles.graphWrap}>
            <div className={styles.graphHead}>
                <span>
                    {total} commit{total > 1 ? 's' : ''}
                    {points.length < total && ` · ${points.length} affichés`}
                </span>
                <span className={styles.graphRange}>
                    {fmt(firstCommitAt)} → {fmt(lastCommitAt)}
                </span>
            </div>

            <svg
                className={styles.graph}
                viewBox={`0 0 1000 ${HEIGHT}`}
                preserveAspectRatio='none'
                style={{ width: `${width}%` }}
                role='img'
                aria-label={`Graphe de ${total} commits`}
            >
                <line x1={PAD_X} y1={HEIGHT - 6} x2={1000 - PAD_X} y2={HEIGHT - 6} className={styles.graphAxis} />
                {points.map((p) => {
                    const dim = highlight !== null && p.authorRef !== highlight;
                    return (
                        <circle
                            key={p.sha}
                            cx={x(p.committedAt)}
                            cy={yOf(p.sha)}
                            r={DOT_R}
                            fill={colorOf(p.authorRef)}
                            // framer-motion n'intervient pas ici, mais on reste
                            // sur `filter` par cohérence avec le reste du module.
                            style={{ filter: dim ? 'opacity(0.12)' : undefined }}
                        />
                    );
                })}
            </svg>

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
