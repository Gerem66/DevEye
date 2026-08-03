import { useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import styles from './style.module.css';

export const MAIL_CONFIRM_POPUP = 'popup-mail-confirm';

export interface ConfirmInput {
    title: string;
    message: string;
    confirmLabel: string;
}

const DEFAULT_INPUT: ConfirmInput = { title: '', message: '', confirmLabel: 'Confirmer' };

/** Lightweight confirm used for destructive message actions (delete). */
export function ConfirmPopup() {
    const [data, setData] = useState<ConfirmInput>(DEFAULT_INPUT);

    function close(result: boolean): void {
        ClosePopup(MAIL_CONFIRM_POPUP, result);
    }

    return (
        <Popup<ConfirmInput | null>
            id={MAIL_CONFIRM_POPUP}
            title={data.title}
            width={420}
            onInputChange={(input) => setData(input ?? DEFAULT_INPUT)}
            onClosePopup={() => close(false)}
            onSubmit={() => close(true)}
        >
            <p className={styles.status}>{data.message}</p>
            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                </div>
                <Button variant='danger' onClick={() => close(true)}>
                    {data.confirmLabel}
                </Button>
            </div>
        </Popup>
    );
}

export default ConfirmPopup;
