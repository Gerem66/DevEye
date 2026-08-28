import type { ProjectLinkLabel } from '../contracts/domain';
import styles from './style.module.css';

interface ForeignLinksProps {
    labels: readonly ProjectLinkLabel[];
    /** La phrase du vide, propre à ce qu'on relie. */
    empty: string;
    /**
     * Rappeler que les liaisons se règlent au domicile. Une fois par onglet :
     * l'onglet Déploiement porte deux sections, seule la dernière le dit.
     */
    note?: boolean;
}

/**
 * Les liaisons d'un projet projeté depuis un autre espace, **en lecture**.
 *
 * Une rangée nommée par liaison, et rien d'autre : ni le bloc du module (qui
 * chargerait l'élément et porterait ses gestes), ni « Ouvrir », ni « Délier »,
 * ni le « + ». Relier et délier sont des gestes du domicile, que le serveur
 * refuse depuis une fenêtre ; et l'élément visé vit dans l'espace d'origine,
 * où le lecteur d'ici n'a pas nécessairement ses entrées. Le nom vient donc du
 * serveur, résolu par le module visé, et suffit à répondre à « à quoi ce
 * projet est-il relié ? » sans ouvrir une porte qui ne mène nulle part.
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
