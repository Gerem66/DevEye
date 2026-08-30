import { addSectionWith } from '@/stores/homeLayout';
import { HOME_STARTERS, starterFeatures } from './starters';
import styles from './Dashboard.module.css';

export interface EmptyHomeProps {
    /** Le droit de composer la disposition (`workspace.layout`). */
    canLayout: boolean;
    /** Le chemin manuel : passer en organisation sur une section neuve. */
    onCompose: () => void;
}

/**
 * L'accueil neuf : des modèles qui posent chacun une section garnie d'un clic,
 * et le chemin manuel en retrait. Un modèle ne se confirme pas, le mode
 * organisation défait tout.
 */
export function EmptyHome({ canLayout, onCompose }: EmptyHomeProps) {
    if (!canLayout) {
        return (
            <div className={styles.emptyHome}>
                <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
                <span className={styles.emptyHomeTitle}>L’accueil de cet espace est vide</span>
                <span className={styles.emptyHomeHint}>Votre rôle ne permet pas d’en modifier la disposition.</span>
            </div>
        );
    }

    // Un modèle dont aucun module n'est installé n'a rien à poser.
    const starters = HOME_STARTERS.map((starter) => ({ starter, entries: starterFeatures(starter) })).filter(
        ({ entries }) => entries.length > 0
    );

    return (
        <div className={styles.emptyHome}>
            <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
            <span className={styles.emptyHomeTitle}>Votre accueil est vide</span>
            <span className={styles.emptyHomeHint}>
                Partez d’un modèle, ou composez votre première section : appareils, fonctionnalités et raccourcis y
                cohabitent.
            </span>

            {starters.length > 0 && (
                <div className={styles.starters}>
                    {starters.map(({ starter, entries }) => (
                        <button
                            key={starter.id}
                            type='button'
                            className={styles.starter}
                            onClick={() =>
                                addSectionWith(
                                    starter.label,
                                    entries.map((entry) => entry.id)
                                )
                            }
                        >
                            <span className={styles.starterHead}>
                                <span className={`icon icon-${starter.icon} ${styles.starterIcon}`} />
                                <span className={styles.starterName}>{starter.label}</span>
                            </span>
                            {/* Ce que le clic va poser, lu au catalogue plutôt que
                                redit dans un texte à maintenir. */}
                            <span className={styles.starterFeatures}>
                                {entries.map((entry) => entry.title).join(', ')}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            <button type='button' className={styles.emptyManual} onClick={onCompose}>
                Composer moi-même
            </button>
        </div>
    );
}
