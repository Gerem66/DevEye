import { useEffect, useState } from 'react';
import { Button, Dialog, DialogCancelButton, ErrorNote, TextInput, type ErrorNoteInput } from 'deveye-sdk-client';
import type { FinanceRecurring } from '../contracts/domain';

import { api, refreshFinance } from './api';
import { amountToInput, formatDate, parseAmount } from './format';
import { errorNote } from './shared';
import styles from './style.module.css';

interface PostDialogProps {
    /** L'échéance dont on enregistre l'occurrence attendue, ou `null` fermé. */
    recurring: FinanceRecurring | null;
    onClose: () => void;
}

/**
 * Enregistrer l'occurrence d'une échéance manuelle : son montant se corrige ici,
 * c'est la raison d'être d'une échéance qui n'est pas automatique.
 */
export function PostDialog({ recurring, onClose }: PostDialogProps) {
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (recurring === null) return;
        setAmount(recurring.amount === 0 ? '' : amountToInput(recurring.amount));
        setError(null);
    }, [recurring]);

    const cents = parseAmount(amount);
    const valid = cents !== null && cents > 0;

    const submit = async () => {
        if (recurring === null || busy || !valid) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.recurringPost', { recurringId: recurring.id, amount: cents });
            refreshFinance();
            onClose();
        } catch (e) {
            setError(errorNote(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={recurring !== null}
            onClose={onClose}
            title='Enregistrer l’échéance'
            description={
                recurring
                    ? `« ${recurring.label || 'Sans intitulé'} », prévue le ${formatDate(recurring.nextDate)}.`
                    : undefined
            }
            width={440}
            onSubmit={() => void submit()}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy || !valid}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Montant de cette fois</span>
                    <TextInput
                        data-autofocus='true'
                        inputMode='decimal'
                        placeholder='0,00'
                        className={styles.amountInput}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                    />
                    <span className={styles.fieldHint}>
                        Seule cette occurrence prend ce montant : l’échéance garde le sien pour la suivante.
                    </span>
                </label>
                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default PostDialog;
