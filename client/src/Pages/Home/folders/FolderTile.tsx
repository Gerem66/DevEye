import type { HomeFolder } from '@deveye/types';

import { catalogEntries } from '../catalog';
import styles from './folders.module.css';

/** Combien de pastilles la carte montre avant de compter le reste. */
const PREVIEW = 5;

/**
 * Le corps de la carte d'un dossier : ce qu'il tient, en pastilles (icône et
 * nom), dans l'ordre du déploiement. Le contenu est relu ici plutôt que reçu en
 * props : la même carte sert la grille et l'organiseur.
 */
export function FolderTile({ folder }: { folder: HomeFolder }) {
    const entries = catalogEntries(folder.items);

    if (entries.length === 0) {
        return (
            <div className={styles.tileEmpty}>
                <span>Dossier vide</span>
                <span className={styles.tileHint}>Ajoutez-y des fonctionnalités depuis « Organiser l’accueil ».</span>
            </div>
        );
    }

    const shown = entries.slice(0, PREVIEW);
    const rest = entries.length - shown.length;
    return (
        <div className={styles.tileBody}>
            <div className={styles.chips}>
                {shown.map((entry) => (
                    <span key={entry.id} className={styles.chip}>
                        <span className={`icon icon-${entry.icon} ${styles.chipIcon}`} aria-hidden='true' />
                        {entry.title}
                    </span>
                ))}
                {rest > 0 && <span className={`${styles.chip} ${styles.chipMore}`}>+{rest}</span>}
            </div>
            <span className={styles.tileCount}>
                {entries.length} fonctionnalité{entries.length > 1 ? 's' : ''}
            </span>
        </div>
    );
}

export default FolderTile;
