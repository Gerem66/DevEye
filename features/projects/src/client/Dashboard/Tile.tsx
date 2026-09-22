import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { SdkTileMetric } from '@deveye/types/sdk/client';

import type { TileSize } from './catalogue';
import styles from '../style.module.css';

interface TileProps {
    tileKey: string;
    title: string;
    /** Deux ou trois chiffres : une tuile n'est pas un écran. */
    metrics: readonly SdkTileMetric[];
    /** Deux pistes de la grille, quand elle en offre au moins deux. */
    size?: TileSize;
    /** Le corps libre d'une tuile de tâches : barres, listes, visages. */
    children?: ReactNode;
    /** Ce qui empêche de mesurer, en une phrase. La tuile reste, elle ne s'excuse pas ailleurs. */
    unavailable?: string | null;
    /** La date de la mesure, quand elle en a une (« mesuré il y a 12 min »). */
    note?: string | null;
    /** Les chiffres datent : ils se montrent grisés. */
    stale?: boolean;
    canWrite: boolean;
    onGripPointerDown?: (e: ReactPointerEvent) => void;
    dragging?: boolean;
    onHide?: () => void;
    /** Gestes propres à la tuile : régler un indicateur, le remesurer. */
    actions?: ReactNode;
}

/**
 * Une tuile de la vue d'ensemble. Toutes se dessinent ici, quelle que soit la
 * feature d'où viennent les chiffres : un tableau de bord dont chaque tuile se
 * dessinerait elle-même ne serait qu'un empilement d'onglets.
 */
export function Tile({
    tileKey,
    title,
    metrics,
    size = 'normal',
    children,
    unavailable,
    note,
    stale = false,
    canWrite,
    onGripPointerDown,
    dragging = false,
    onHide,
    actions
}: TileProps) {
    return (
        <section
            className={dragging ? styles.dashTileDragging : styles.dashTile}
            data-dash-tile=''
            data-key={tileKey}
            data-size={size}
        >
            <header className={styles.dashTileHead}>
                <p className={styles.dashTileName} title={title}>
                    {title}
                </p>
                {canWrite && (
                    <div className={styles.dashTileActions}>
                        {actions}
                        {onHide && (
                            <button
                                type='button'
                                className={styles.dashTileBtn}
                                title='Masquer cette tuile'
                                aria-label={`Masquer « ${title} »`}
                                onClick={onHide}
                            >
                                <span className='icon icon-eye-close' />
                            </button>
                        )}
                        {onGripPointerDown && (
                            <button
                                type='button'
                                className={styles.dashGrip}
                                title='Déplacer cette tuile'
                                aria-label={`Déplacer « ${title} »`}
                                onPointerDown={onGripPointerDown}
                            >
                                <span className='icon icon-drag' />
                            </button>
                        )}
                    </div>
                )}
            </header>

            {metrics.length > 0 && (
                <div className={styles.dashMetrics}>
                    {metrics.map((metric) => (
                        <div key={metric.key} className={styles.dashMetric}>
                            <span
                                className={`${styles.dashMetricValue} ${stale ? styles.dashStale : ''}`}
                                data-tone={metric.tone ?? 'neutral'}
                            >
                                {metric.value}
                            </span>
                            <span className={styles.dashMetricLabel}>{metric.label}</span>
                        </div>
                    ))}
                </div>
            )}

            {children && <div className={styles.dashTileBody}>{children}</div>}

            {unavailable && <p className={styles.dashTileError}>{unavailable}</p>}
            {!unavailable && note && <p className={styles.dashTileNote}>{note}</p>}
        </section>
    );
}

export default Tile;
