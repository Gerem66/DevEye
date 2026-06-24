import { useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';

export const NOTE_CONFIRM_POPUP = 'popup-note-confirm';

export interface ConfirmInput {
    title: string;
    message: string;
    confirmLabel: string;
}

/** Lightweight confirm used for destructive folder actions (delete). */
export default function ConfirmPopup() {
    const [data, setData] = useState<ConfirmInput>({ title: '', message: '', confirmLabel: 'Confirmer' });

    function close(result: boolean) {
        ClosePopup(NOTE_CONFIRM_POPUP, result);
    }

    return (
        <Popup<ConfirmInput | null>
            id={NOTE_CONFIRM_POPUP}
            title={data.title}
            width={420}
            onInputChange={(input) => input && setData(input)}
            onClosePopup={() => close(false)}
            onSubmit={() => close(true)}
        >
            <p className={styles.popupHint}>{data.message}</p>
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(false)}>
                        Annuler
                    </Button>
                    <Button variant='danger' onClick={() => close(true)}>
                        {data.confirmLabel}
                    </Button>
                </div>
            </div>
        </Popup>
    );
}
