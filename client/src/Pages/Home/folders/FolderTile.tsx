import type { HomeFolder } from 'deveye-types';

import { useAuth } from '@/auth/AuthProvider';
import { useActiveWorkspace } from '@/stores/workspace';
import { folderFeatures } from '../catalog';
import styles from './folders.module.css';

/** Combien de pastilles la carte montre avant de compter le reste. */
const PREVIEW = 5;

/**
 * Le corps de la carte d'un dossier : ce qu'il tient, en pastilles.
 *
 * Une carte de dossier a la même tête que les autres, donc son corps doit dire
 * ce qu'il y a derrière, sinon rien ne distingue deux dossiers l'un de l'autre.
 * Les pastilles portent l'icône **et** le nom de chaque fonctionnalité : c'est
 * ce qu'on retrouvera déployé au clic, dans cet ordre.
 *
 * Le contexte est lu ici plutôt que reçu en props, comme le font les autres
 * corps de tuiles : la même carte sert la grille et l'organiseur, et ni l'un ni
 * l'autre n'a à savoir qu'un dossier filtre son contenu.
 */
export function FolderTile({ folder }: { folder: HomeFolder }) {
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const entries = folderFeatures(folder.items, { kind: workspace?.kind, isAdmin: user?.role === 'admin' });

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
