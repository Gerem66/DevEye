import type { ProjectLinkLabel } from '../contracts/domain';
import styles from './style.module.css';

interface ForeignLinksProps {
    labels: readonly ProjectLinkLabel[];
    empty: string;
    /** Le rappel « ça se règle au domicile », affiché une seule fois par onglet. */
    note?: boolean;
}

/**
 * Les liaisons d'un projet projeté depuis un autre espace, en lecture seule :
 * ni « Ouvrir », ni « Délier », ni « + ». Relier et délier sont des gestes du
 * domicile, que le serveur refuse depuis une fenêtre.
 */
export function ForeignLinks({ labels, empty, note = true }: ForeignLinksProps) {
    return (
        <div className={styles.foreignLinks}>
            {labels.length === 0 && <p className={styles.empty}>{empty}</p>}

            {labels.map(({ id, label }) => (
                <div key={id} className={styles.foreignLink}>
                    {label === null ? (
                        <span className={styles.foreignLinkGone}>Élément disparu</span>
                    ) : (
                        <span className={styles.foreignLinkName}>{label}</span>
                    )}
                </div>
            ))}

            {note && (
                <span className={styles.hintCentered}>
                    Ce projet est partagé depuis un autre espace : ses liaisons se règlent là-bas.
                </span>
            )}
        </div>
    );
}

export default ForeignLinks;
