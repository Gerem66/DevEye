import { Dialog } from '@/Components/Dialog';
import styles from './ProgressDialog.module.css';

interface ProgressDialogProps {
    open: boolean;
    title: string;
    /** Ce qui se fait, et pourquoi il faut attendre. */
    description?: string;
}

/**
 * Une opération longue en cours : un dialogue que rien ne ferme tant qu'elle
 * dure, et une barre indéterminée. Sans lui, un geste de plusieurs secondes
 * laisse un écran figé où l'on ne sait pas si le clic a pris.
 */
export function ProgressDialog({ open, title, description }: ProgressDialogProps) {
    return (
        <Dialog
            open={open}
            onClose={() => {}}
            title={title}
            dismissible={false}
            closeButton={false}
            autoFocus={false}
            width={420}
        >
            {description && <p className={styles.text}>{description}</p>}
            <div className={styles.track} role='progressbar' aria-label={title} aria-busy='true'>
                <div className={styles.fill} />
            </div>
        </Dialog>
    );
}

export default ProgressDialog;
