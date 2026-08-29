import type { AudienceFunnel } from '../../contracts/domain';

import { formatCount, formatPercent, funnelSegments } from '../format';
import styles from '../style.module.css';

interface FunnelBarProps {
    funnel: AudienceFunnel;
    onOpen: () => void;
}

/**
 * Un entonnoir ramené à une seule barre, cliquable : les parts somment à 1, et
 * l'œil lit la proportion sans comparer des hauteurs entre elles.
 *
 * Trois teintes, pas une de plus : ce qui a converti, l'abandon le plus
 * coûteux, et le reste. Colorer chaque marche demanderait une légende, donc un
 * aller-retour du regard pour une vue qui existe pour l'éviter.
 */
export function FunnelBar({ funnel, onOpen }: FunnelBarProps) {
    const counts = funnel.steps.map((step) => step.sessions);
    const entered = counts[0] ?? 0;
    const done = counts[counts.length - 1] ?? 0;
    const segments = funnelSegments(counts);

    return (
        <button type='button' className={styles.funnelCard} onClick={onOpen}>
            <span className={styles.funnelCardHead}>
                <span className={styles.funnelCardName}>{funnel.name}</span>
                <span className={styles.funnelCardRate}>
                    {entered > 0 ? `${formatPercent(done / entered)} de bout en bout` : 'aucune visite'}
                </span>
            </span>

            <span className={styles.funnelSegments}>
                {segments.length === 0 ? (
                    // Rien à répartir : une barre pleine de zéros laisserait croire à
                    // une mesure, on montre la piste vide.
                    <span className={styles.funnelSegmentEmpty} />
                ) : (
                    segments.map((segment) => (
                        <span
                            key={`${segment.kind}-${segment.step}`}
                            className={
                                segment.kind === 'done'
                                    ? styles.funnelSegmentDone
                                    : segment.worst
                                      ? styles.funnelSegmentWorst
                                      : styles.funnelSegmentLost
                            }
                            style={{ width: `${segment.share * 100}%` }}
                            title={
                                segment.kind === 'done'
                                    ? `${formatCount(done)} arrivées au bout`
                                    : `${formatCount(counts[segment.step] - counts[segment.step + 1])} abandons après « ${
                                          funnel.steps[segment.step].value
                                      } »`
                            }
                        />
                    ))
                )}
            </span>

            <span className={styles.funnelCardFoot}>
                {formatCount(entered)} entrées · {formatCount(done)} au bout · {funnel.steps.length} marches
            </span>
        </button>
    );
}

export default FunnelBar;
