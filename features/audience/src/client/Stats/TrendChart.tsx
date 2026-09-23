import { useId, useState } from 'react';
import type { AudiencePoint, AudienceResolution } from '../../contracts/domain';

import { formatCount, formatPointLabel, formatPointTitle } from '../format';
import styles from '../style.module.css';

const W = 720;
const H = 180;
/** Place laissée sous la courbe pour les étiquettes de l'axe. */
const PAD_BOTTOM = 22;

interface TrendChartProps {
    points: AudiencePoint[];
    resolution: AudienceResolution;
    /** Bornes de la fenêtre, pour que l'axe couvre la période demandée. */
    from: number;
    to: number;
    bucket: number;
}

/**
 * La courbe des vues et des visiteurs sur la période.
 *
 * `viewBox` fixe, sans `ResizeObserver` : le SVG s'adapte à son conteneur par
 * mise à l'échelle, donc le dessin ne coûte aucun recalcul au redimensionnement.
 *
 * L'axe est la fenêtre demandée et non l'étendue des données : un site qui n'a
 * reçu ses premières visites qu'hier dessine sa courbe dans le dernier dixième
 * d'une vue « 30 jours », au lieu de laisser croire à un mois d'activité.
 *
 * Deux séries superposées et non deux graphiques : « 400 vues pour 120
 * visiteurs » est une seule information, qui disparaît si l'on doit comparer
 * deux échelles côte à côte.
 */
export function TrendChart({ points, resolution, from, to, bucket }: TrendChartProps) {
    const [hover, setHover] = useState<AudiencePoint | null>(null);
    // Unique par instance : deux courbes sur la même page (un projet relié à deux
    // sites) partageraient sinon le même dégradé.
    const fillId = useId();

    // Les seaux vides ne remontent pas de SQL, un GROUP BY ne rendant que ce qui
    // existe : sans cette grille complète, deux jours sans visite se toucheraient et la
    // courbe mentirait sur le rythme.
    const slots: AudiencePoint[] = [];
    const byAt = new Map(points.map((p) => [p.at, p]));
    for (let at = from; at < to; at += bucket) {
        slots.push(byAt.get(at) ?? { at, views: 0, visitors: 0 });
    }

    const max = Math.max(1, ...slots.map((s) => s.views));
    const totalViews = slots.reduce((sum, slot) => sum + slot.views, 0);
    const plotH = H - PAD_BOTTOM;
    const step = W / Math.max(1, slots.length);
    const x = (index: number) => index * step + step / 2;
    const y = (value: number) => plotH - (value / (max * 1.15)) * plotH;

    const line = (pick: (p: AudiencePoint) => number) =>
        slots.map((slot, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(pick(slot)).toFixed(1)}`).join(' ');

    const area = `${line((p) => p.views)} L ${x(slots.length - 1).toFixed(1)} ${plotH} L ${x(0).toFixed(1)} ${plotH} Z`;

    // Une étiquette sur six au plus : au-delà elles se chevauchent, et aucune n'est
    // lisible. La première et la dernière sont toujours du lot.
    const labelEvery = Math.max(1, Math.ceil(slots.length / 6));

    return (
        <figure className={styles.chart}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className={styles.chartSvg}
                role='img'
                // Un dessin sans ses totaux ne dit rien à qui ne le voit pas.
                aria-label={`Vues sur la période : ${totalViews} au total, ${max} au plus haut.`}
            >
                <defs>
                    <linearGradient id={fillId} x1='0' y1='0' x2='0' y2='1'>
                        <stop offset='0%' stopColor='var(--accent)' stopOpacity='0.28' />
                        <stop offset='100%' stopColor='var(--accent)' stopOpacity='0' />
                    </linearGradient>
                </defs>

                <path d={area} fill={`url(#${fillId})`} />
                <path d={line((p) => p.views)} className={styles.chartLine} />
                <path d={line((p) => p.visitors)} className={styles.chartLineSecondary} />

                {slots.map((slot, i) =>
                    i % labelEvery === 0 || i === slots.length - 1 ? (
                        <text key={slot.at} x={x(i)} y={H - 6} className={styles.chartTick} textAnchor='middle'>
                            {formatPointLabel(slot.at, resolution)}
                        </text>
                    ) : null
                )}

                {hover && (
                    <line
                        x1={x(slots.indexOf(hover))}
                        x2={x(slots.indexOf(hover))}
                        y1={0}
                        y2={plotH}
                        className={styles.chartCursor}
                    />
                )}

                {/* Une bande transparente par seau : le survol vise une colonne entière,
                    et non un point de deux pixels à chercher à la souris. */}
                {slots.map((slot, i) => (
                    <rect
                        key={`hit-${slot.at}`}
                        x={i * step}
                        y={0}
                        width={step}
                        height={plotH}
                        fill='transparent'
                        onMouseEnter={() => setHover(slot)}
                        onMouseLeave={() => setHover(null)}
                    />
                ))}
            </svg>

            {/* La légende porte la valeur survolée : une info-bulle flottante
                demanderait de suivre le pointeur, et sauterait d'un bord à l'autre sur
                les colonnes de rive. */}
            <figcaption className={styles.chartLegend}>
                <span className={styles.legendItem}>
                    <span className={styles.legendSwatch} data-series='views' aria-hidden='true' />
                    {formatCount(hover ? hover.views : slots.reduce((sum, s) => sum + s.views, 0))} vues
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendSwatch} data-series='visitors' aria-hidden='true' />
                    {formatCount(hover ? hover.visitors : Math.max(...slots.map((s) => s.visitors), 0))} visiteurs
                    {!hover && <span className={styles.legendNote}>au plus haut</span>}
                </span>
                <span className={styles.legendWhen}>
                    {hover ? formatPointTitle(hover.at, resolution) : 'survolez la courbe'}
                </span>
            </figcaption>
        </figure>
    );
}

export default TrendChart;
