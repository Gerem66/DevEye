import type { CloudSyncShareState } from 'deveye-types';
import styles from './style.module.css';

type State = CloudSyncShareState['state'];

/**
 * L'icône d'état du héros (et du widget), en SVG *inline* : chaque tracé se
 * « dessine » à l'apparition via `stroke-dashoffset` (cf. `.draw`). Comme la
 * carte remonte le composant à chaque changement d'état (`key={state}`), passer
 * d'un état à l'autre rejoue ce remplissage — la transition est fluide.
 *
 * Le spinner fait exception : un arc tourne en continu (pas de remontage tant
 * qu'on reste en « synchronisation »), pour ne jamais figer l'animation.
 *
 * `pathLength={1}` normalise chaque forme : un seul `stroke-dasharray: 1` suffit
 * quelles que soient les longueurs réelles.
 */

/** La marque intérieure attend que l'anneau soit tracé (ms). */
const MARK_DELAY = 240;

interface HeroIconProps {
    state: State;
    /** Classe de dimensionnement fournie par l'appelant (héros 112px / widget 52px). */
    className?: string;
}

function Ring() {
    return <circle className={styles.draw} cx={12} cy={12} r={9.2} pathLength={1} />;
}

function mark(state: State) {
    switch (state) {
        case 'synced':
            return (
                <polyline
                    className={styles.draw}
                    style={{ animationDelay: `${MARK_DELAY}ms` }}
                    points='8,12.4 10.8,15.2 16,9'
                    pathLength={1}
                />
            );
        case 'error':
            return (
                <>
                    <line
                        className={styles.draw}
                        style={{ animationDelay: `${MARK_DELAY}ms` }}
                        x1={9}
                        y1={9}
                        x2={15}
                        y2={15}
                        pathLength={1}
                    />
                    <line
                        className={styles.draw}
                        style={{ animationDelay: `${MARK_DELAY + 140}ms` }}
                        x1={15}
                        y1={9}
                        x2={9}
                        y2={15}
                        pathLength={1}
                    />
                </>
            );
        case 'paused':
            return (
                <>
                    <line
                        className={styles.draw}
                        style={{ animationDelay: `${MARK_DELAY}ms` }}
                        x1={10.2}
                        y1={8.6}
                        x2={10.2}
                        y2={15.4}
                        pathLength={1}
                    />
                    <line
                        className={styles.draw}
                        style={{ animationDelay: `${MARK_DELAY + 90}ms` }}
                        x1={13.8}
                        y1={8.6}
                        x2={13.8}
                        y2={15.4}
                        pathLength={1}
                    />
                </>
            );
        default:
            return null;
    }
}

export default function HeroIcon({ state, className }: HeroIconProps) {
    const cls = `${styles.stateSvg} ${state === 'syncing' ? styles.stateSvgSpinning : ''} ${className ?? ''}`;
    return (
        <svg
            className={cls}
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth={1.2}
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
        >
            {state === 'syncing' ? (
                <>
                    <circle className={styles.spinRing} cx={12} cy={12} r={9.2} />
                    <circle className={styles.spinArc} cx={12} cy={12} r={9.2} pathLength={1} />
                </>
            ) : state === 'offline' ? (
                <path className={styles.draw} d='M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z' pathLength={1} />
            ) : (
                <>
                    <Ring />
                    {mark(state)}
                </>
            )}
        </svg>
    );
}
