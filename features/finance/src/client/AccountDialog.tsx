import { useEffect, useState } from 'react';
import {
    Button,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    SegmentedControl,
    TextInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { FinanceAccountKind, FinanceColor } from '../contracts/domain';
import { FINANCE_NAME_MAX_LENGTH } from '../contracts/domain';

import ColorPicker from './ColorPicker';
import { api } from './api';
import { ACCOUNT_KINDS, parseAmount } from './format';
import { errorNote } from './shared';
import styles from './style.module.css';

interface AccountDialogProps {
    open: boolean;
    onClose: () => void;
    onCreated: (id: number) => void;
}

interface Draft {
    name: string;
    kind: FinanceAccountKind;
    color: FinanceColor;
    balance: string;
}

const EMPTY: Draft = { name: '', kind: 'checking', color: 'blue', balance: '' };

/**
 * La création d'un compte, et rien d'autre : le modifier, l'archiver ou le
 * retirer se fait dans l'onglet Général de ses réglages, depuis sa fiche.
 */
export function AccountDialog({ open, onClose, onCreated }: AccountDialogProps) {
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [showNameError, setShowNameError] = useState(false);

    useEffect(() => {
        if (!open) return;
        setDraft(EMPTY);
        setError(null);
        setShowNameError(false);
    }, [open]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

    const balance = draft.balance.trim() === '' ? 0 : parseAmount(draft.balance);
    const kind = ACCOUNT_KINDS.find((entry) => entry.id === draft.kind);

    const submit = async () => {
        if (busy) return;
        const name = draft.name.trim();
        if (name === '') {
            setShowNameError(true);
            return;
        }
        if (balance === null) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('finance.accountAdd', {
                account: {
                    name,
                    kind: draft.kind,
                    color: draft.color,
                    initialBalance: balance,
                    note: '',
                    archived: false
                }
            });
            onCreated(res.account.id);
        } catch (e) {
            setError(errorNote(e, 'Création impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Nouveau compte'
            description='Le compte de votre activité : celui où arrivent les règlements et d’où partent les dépenses.'
            width={520}
            onSubmit={() => void submit()}
            dirty={JSON.stringify(draft) !== JSON.stringify(EMPTY)}
            onSave={() => void submit()}
            footer={
                <>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy || balance === null}>
                        {busy ? 'Création…' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom</span>
                    <TextInput
                        data-autofocus='true'
                        placeholder='ex. Compte pro'
                        maxLength={FINANCE_NAME_MAX_LENGTH}
                        value={draft.name}
                        error={showNameError && draft.name.trim() === '' ? 'Nom requis' : undefined}
                        onChange={(e) => {
                            set('name', e.target.value);
                            setShowNameError(false);
                        }}
                    />
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Type</span>
                    <SegmentedControl
                        aria-label='Type de compte'
                        fullWidth
                        value={draft.kind}
                        options={ACCOUNT_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
                        onChange={(value) => set('kind', value)}
                    />
                    {kind && <span className={styles.fieldHint}>{kind.hint}</span>}
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Solde d’aujourd’hui</span>
                    <TextInput
                        inputMode='decimal'
                        placeholder='0,00'
                        className={styles.amountInput}
                        value={draft.balance}
                        error={balance === null ? 'Montant illisible' : undefined}
                        onChange={(e) => set('balance', e.target.value)}
                    />
                    <span className={styles.fieldHint}>
                        Ce qu’indique votre banque aujourd’hui : tous les soldes suivants s’en déduisent. Un découvert
                        se note avec un signe moins.
                    </span>
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Couleur</span>
                    <ColorPicker
                        aria-label='Couleur du compte'
                        value={draft.color}
                        onChange={(value) => set('color', value)}
                    />
                </div>

                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default AccountDialog;
