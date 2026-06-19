import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';

import styles from './style.module.css';

export const NOTE_LOCK_MANAGE_POPUP = 'popup-note-lock-manage';

/** What the user chose to do with an already-locked note's lock. */
export type LockManageResult = 'change' | 'remove' | null;

/**
 * Lock-management choices for an already-locked note, opened from the editor's
 * padlock toggle. Opening the editor already proved authorization, so removing
 * the lock needs no password re-check. Resolves OpenPopup with the chosen action
 * (`'change'` / `'remove'`) or `null` on cancel.
 */
export default function LockManagePopup() {
    function close(result: LockManageResult) {
        ClosePopup(NOTE_LOCK_MANAGE_POPUP, result);
    }

    return (
        <Popup id={NOTE_LOCK_MANAGE_POPUP} title='Verrou de la note' width={420} onClosePopup={() => close(null)}>
            <p className={styles.popupHint}>
                Cette note est protégée par son propre mot de passe. Que souhaitez-vous faire ?
            </p>
            <div className={styles.lockManageActions}>
                <Button variant='secondary' onClick={() => close(null)}>
                    Annuler
                </Button>
                <Button variant='secondary' onClick={() => close('change')}>
                    Changer le mot de passe
                </Button>
                <Button variant='danger' onClick={() => close('remove')}>
                    Retirer le verrou
                </Button>
            </div>
        </Popup>
    );
}
