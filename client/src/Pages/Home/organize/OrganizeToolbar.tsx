import Button from '@/Components/Button';
import styles from './organize.module.css';

export interface OrganizeToolbarProps {
    onDone: () => void;
}

/** Banner shown above the grid while organizing. Adding tiles happens per
 *  category (the "+" in each), so this only explains the mode and exits it. */
export function OrganizeToolbar({ onDone }: OrganizeToolbarProps) {
    return (
        <div className={styles.toolbar}>
            <div className={styles.toolbarText}>
                <span className={`icon icon-edit ${styles.toolbarIcon}`} />
                <div>
                    <span className={styles.toolbarTitle}>Organisation de l’accueil</span>
                    <span className={styles.toolbarHint}>
                        Glissez les tuiles ou les catégories, retirez avec ×, ajoutez avec « + ».
                    </span>
                </div>
            </div>
            <Button variant='primary' icon='check-circle' onClick={onDone}>
                Terminer
            </Button>
        </div>
    );
}

export default OrganizeToolbar;
