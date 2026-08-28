import type { AudienceFunnel } from '../../contracts/domain';

import { formatCount, formatPercent, funnelDrops } from '../format';
import styles from '../style.module.css';

interface FunnelStepsProps {
    funnel: AudienceFunnel;
}

/**
 * Le détail d'un entonnoir, marche par marche.
 *
 * **L'abandon est un lien entre deux marches, pas une propriété de l'une
 * d'elles.** Il est donc rendu *au-dessus* de la marche dans laquelle il
 * conduit, et jamais sous celle qu'on vient de quitter. La première marche n'en
 * a pas — rien ne la précède — et c'est le seul écart légitime dans le rythme.
 * Le poser en dessous, comme au premier jet, collait la première marche à la
 * deuxième et désalignait toute la colonne.
 *
 * La largeur d'une barre est rapportée à la **première** marche : un entonnoir
 * se lit comme une part de ceux qui sont entrés. La rapporter à la marche
 * précédente aurait donné des barres presque pleines partout, masquant
 * exactement ce qu'on vient voir.
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
                            {i === worst && (drops[i] as number) > 0 ? ' — le plus coûteux' : ''}
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
