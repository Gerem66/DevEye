import { useRef } from 'react';
import { Dialog } from 'deveye-sdk-client';

import styles from './style.module.css';

/** Ce qu'un incident ou une lecture des fichiers a à montrer, au-delà de sa ligne. */
export interface Detail {
    title: string;
    description: string;
    /** L'écart fichier par fichier, ou ce qui explique le constat. */
    lines: string[];
}

interface DetailDialogProps {
    detail: Detail | null;
    onClose: () => void;
}

/** Le détail d'une ligne de la fiche, dans un dialogue plutôt que déroulé sous elle. */
export function DetailDialog({ detail, onClose }: DetailDialogProps) {
    // Le dernier détail reste le temps de l'animation de sortie, sans quoi le
    // titre se viderait avant que le dialogue ne disparaisse.
    const shown = useRef<Detail | null>(detail);
    if (detail) shown.current = detail;
    const view = detail ?? shown.current;

    return (
        <Dialog open={detail !== null} onClose={onClose} title={view?.title} description={view?.description}>
            {view && view.lines.length > 0 && (
                <ul className={styles.driftLines}>
                    {view.lines.map((line, i) => (
                        <li key={i}>{line}</li>
                    ))}
                </ul>
            )}
        </Dialog>
    );
}

export default DetailDialog;
