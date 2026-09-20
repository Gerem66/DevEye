import { Dialog } from '@/Components/Dialog';
import styles from './ProgressDialog.module.css';

interface ProgressDialogProps {
    open: boolean;
    title: string;
    /** Ce qui se fait, et pourquoi il faut attendre. */
    description?: string;
    /** L'avancement, de 0 à 1, quand il se mesure. Absent : la barre balaie sans rien promettre. */
    value?: number;
    /** L'étape en cours, sous la barre. */
    step?: string;
}

/**
 * Une opération longue en cours : un dialogue que rien ne ferme tant qu'elle
 * dure, et une barre. Sans lui, un geste de plusieurs secondes laisse un écran
 * figé où l'on ne sait pas si le clic a pris.
 */
export function ProgressDialog({ open, title, description, value, step }: ProgressDialogProps) {
    const percent = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
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
            <div
                className={styles.track}
                role='progressbar'
                aria-label={title}
                aria-busy='true'
                aria-valuemin={percent === undefined ? undefined : 0}
                aria-valuemax={percent === undefined ? undefined : 100}
                aria-valuenow={percent}
            >
                {percent === undefined ? (
                    <div className={styles.fill} />
                ) : (
                    <div className={styles.measured} style={{ width: `${percent}%` }} />
                )}
            </div>
            {step && <p className={styles.step}>{step}</p>}
        </Dialog>
    );
}

export default ProgressDialog;
