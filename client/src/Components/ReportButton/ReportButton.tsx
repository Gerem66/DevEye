import { useEffect, useRef, useState } from 'react';

import { Hint, useHint } from '@/Components/Hint';
import { useFeedbackEnabled } from '@/stores/feedbackEnabled';
import { onOpenReportRequest } from '@/stores/reportRequest';
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
 *
 * La bulle de présentation l'accompagne tant que le compte ne l'a pas écartée,
 * par sa croix ou en ouvrant le formulaire.
 */
export function ReportButton() {
    const enabled = useFeedbackEnabled();
    const hint = useHint('feedbackHintDismissed', enabled);
    const [open, setOpen] = useState(false);
    const [context, setContext] = useState<string | null>(null);

    // Le gestionnaire est réenregistré à chaque rendu sans relancer l'effet :
    // il lit `user` par la référence, et un effet qui dépendrait du compte se
    // désenregistrerait à chaque changement de réglage.
    const openRef = useRef<(context: string | null) => void>(() => {});
    useEffect(() => onOpenReportRequest((from) => openRef.current(from)), []);

    if (!enabled) return null;

    const openDialog = (from: string | null = null): void => {
        hint.dismiss();
        setContext(from);
        setOpen(true);
    };
    openRef.current = openDialog;

    return (
        <>
            {!open && (
                <>
                    {hint.show && (
                        <Hint title='Bienvenue sur DevEye' placement='corner-left' onDismiss={hint.dismiss}>
                            La plateforme est toute jeune. Un bug, une idée, une remarque ? Ce bouton nous l’envoie
                            directement.
                        </Hint>
                    )}
                    <button
                        type='button'
                        className={`${styles.trigger} ${hint.show ? styles.triggerHinted : ''}`}
                        onClick={() => openDialog()}
                        title='Signaler un bug ou faire un retour'
                        aria-label='Signaler un bug ou faire un retour'
                    >
                        <span className='icon icon-bug' />
                    </button>
                </>
            )}
            <ReportDialog open={open} context={context} onClose={() => setOpen(false)} />
        </>
    );
}

export default ReportButton;
