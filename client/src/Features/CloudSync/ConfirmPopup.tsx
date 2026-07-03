import { useState } from 'react';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import styles from './style.module.css';

export const CLOUDSYNC_CONFIRM_POPUP = 'popup-cloudsync-confirm';

export interface ConfirmInput {
    title: string;
    message: string;
    confirmLabel: string;
}

/** Confirmation légère des actions destructrices (même pattern que Notes). */
export default function ConfirmPopup() {
    const [data, setData] = useState<ConfirmInput>({ title: '', message: '', confirmLabel: 'Confirmer' });

    function close(result: boolean) {
        ClosePopup(CLOUDSYNC_CONFIRM_POPUP, result);
    }

    return (
        <Popup<ConfirmInput | null>
            id={CLOUDSYNC_CONFIRM_POPUP}
            title={data.title}
            width={420}
            onInputChange={(input) => input && setData(input)}
            onClosePopup={() => close(false)}
            onSubmit={() => close(true)}
        >
            <p className={styles.confirmMessage}>{data.message}</p>
            <div className={styles.confirmActions}>
                <Button variant='secondary' onClick={() => close(false)}>
                    Annuler
                </Button>
                <Button variant='danger' onClick={() => close(true)}>
                    {data.confirmLabel}
                </Button>
            </div>
        </Popup>
    );
}
