import { useState } from 'react';
import type { UserSettingFlag } from '@deveye/types';

import { ws } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { useFeedbackEnabled } from '@/stores/feedbackEnabled';
import { FeedbackHint } from './FeedbackHint';
import { ReportDialog } from './ReportDialog';

import styles from './ReportButton.module.css';

const HINT_DISMISSED: UserSettingFlag = 'feedbackHintDismissed';

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
    const { user, updateUser } = useAuth();
    const [open, setOpen] = useState(false);

    if (!enabled) return null;

    const showHint = user != null && !user.settings.includes(HINT_DISMISSED);

    /**
     * Le drapeau vit sur le compte : la bulle ne revient donc ni au
     * rechargement ni sur une autre machine. L'état local part devant, un
     * serveur qui refuse n'a pas à la faire réapparaître sous les yeux ; la
     * session suivante la reproposera.
     */
    const dismissHint = (): void => {
        if (!user || user.settings.includes(HINT_DISMISSED)) return;
        updateUser({ settings: [...user.settings, HINT_DISMISSED] });
        void ws.send('user.setSetting', { flag: HINT_DISMISSED, enabled: true }).then(
            (res) => updateUser({ settings: res.settings }),
            () => {}
        );
    };

    const openDialog = (): void => {
        dismissHint();
        setOpen(true);
    };

    return (
        <>
            {!open && (
                <>
                    {showHint && <FeedbackHint onDismiss={dismissHint} />}
                    <button
                        type='button'
                        className={`${styles.trigger} ${showHint ? styles.triggerHinted : ''}`}
                        onClick={openDialog}
                        title='Signaler un bug ou faire un retour'
                        aria-label='Signaler un bug ou faire un retour'
                    >
                        <span className='icon icon-bug' />
                    </button>
                </>
            )}
            <ReportDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
}

export default ReportButton;
