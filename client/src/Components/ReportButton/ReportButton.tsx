import { useState } from 'react';

import { useFeedbackEnabled } from '@/stores/feedbackEnabled';
import { ReportDialog } from './ReportDialog';

import styles from './ReportButton.module.css';

/**
 * Le bouton de signalement, en bas à gauche et au-dessus de tout le reste
 * (`--z-report`) : il doit rester atteignable depuis n'importe quel écran, y
 * compris par-dessus une vue plein écran ou un dialogue ouvert.
 *
 * Il s'efface pendant que sa propre fenêtre est ouverte, le seul moment où il
 * n'a rien à proposer. Monté sous session ouverte : un signalement porte
 * toujours un auteur.
 */
export function ReportButton() {
    const enabled = useFeedbackEnabled();
    const [open, setOpen] = useState(false);

    if (!enabled) return null;

    return (
        <>
            {!open && (
                <button
                    type='button'
                    className={styles.trigger}
                    onClick={() => setOpen(true)}
                    title='Signaler un bug ou faire un retour'
                    aria-label='Signaler un bug ou faire un retour'
                >
                    <span className='icon icon-bug' />
                </button>
            )}
            <ReportDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
}

export default ReportButton;
