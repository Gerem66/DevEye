import type { AudienceFunnel } from '../../contracts/domain';

import { formatCount, formatPercent, funnelDrops } from '../format';
import styles from '../style.module.css';

interface FunnelStepsProps {
    funnel: AudienceFunnel;
}

/**
 * Le détail d'un entonnoir, marche par marche.
 *
 * L'abandon est un lien entre deux marches et non une propriété de l'une
 * d'elles : il est rendu au-dessus de la marche dans laquelle il conduit, et la
 * première n'en a pas, puisque rien ne la précède.
 *
 * La largeur d'une barre est rapportée à la première marche : un entonnoir se
 * lit comme une part de ceux qui sont entrés, et la rapporter à la marche
 * précédente donnerait des barres presque pleines partout.
 */
export function FunnelSteps({ funnel }: FunnelStepsProps) {
    const entered = funnel.steps[0]?.sessions ?? 0;
    const { drops, worst } = funnelDrops(funnel.steps.map((step) => step.sessions));

    return (
        <ol className={styles.funnel}>
            {funnel.steps.map((step, i) => (
                <li key={`${step.kind}-${step.value}-${i}`} className={styles.funnelStep}>
                    {drops[i] !== null && (
                        <p className={i === worst ? styles.funnelLinkWorst : styles.funnelLink}>
                            <span className={`icon icon-chevron ${styles.funnelLinkIcon}`} aria-hidden='true' />
                            {formatPercent(drops[i] as number)} d’abandon
                            {i === worst && (drops[i] as number) > 0 ? ' (le plus coûteux)' : ''}
                        </p>
                    )}

                    <div className={styles.funnelLabel}>
                        <span className={styles.funnelKind}>{step.kind === 'path' ? 'page' : 'évén.'}</span>
                        <span className={styles.funnelValue} title={step.value}>
                            {step.value || <em>illisible</em>}
                        </span>
                        <span className={styles.funnelCount}>
                            {formatCount(step.sessions)}
                            {entered > 0 && (
                                <span className={styles.funnelShare}>{formatPercent(step.sessions / entered)}</span>
                            )}
                        </span>
                    </div>

                    <div className={styles.funnelTrack}>
                        <div
                            className={styles.funnelBar}
                            style={{ width: entered > 0 ? `${(step.sessions / entered) * 100}%` : '0%' }}
                        />
                    </div>
                </li>
            ))}
        </ol>
    );
}

export default FunnelSteps;
