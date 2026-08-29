import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, DialogCancelButton, humanizeError, SelectInput, TextInput } from 'deveye-sdk-client';
import type { FinanceAccount, FinanceAccountKind, FinanceColor } from '../contracts/domain';
import { FINANCE_COLORS, FINANCE_NAME_MAX_LENGTH, FINANCE_NOTE_MAX_LENGTH } from '../contracts/domain';

import { api } from './api';
import { ACCOUNT_KINDS, amountToInput, parseAmount } from './format';
import { colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface AccountDialogProps {
    base: FinanceBase;
    open: boolean;
    account: FinanceAccount | null;
    onClose: () => void;
    onSaved: () => void;
}

interface Draft {
    name: string;
    kind: FinanceAccountKind;
    color: FinanceColor;
    initialBalance: string;
    note: string;
    archived: boolean;
}

/**
 * Le solde de départ est « combien il y a au moment où je commence ce livre »,
 * pas le solde d'ouverture du compte : se tromper décale tous les soldes suivants.
 */
export function AccountDialog({ base, open, account, onClose, onSaved }: AccountDialogProps) {
    const initial = useMemo<Draft>(
        () => ({
            name: account?.name ?? '',
            kind: account?.kind ?? 'checking',
            color: account?.color ?? 'blue',
            initialBalance: amountToInput(account?.initialBalance ?? 0),
            note: account?.note ?? '',
            archived: account?.archived ?? false
        }),
        [account]
    );

    const [draft, setDraft] = useState<Draft>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showNameError, setShowNameError] = useState(false);

    useEffect(() => {
        if (!open) return;
        setDraft(initial);
        setError(null);
        setShowNameError(false);
    }, [open, initial]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

    const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

    const submit = async () => {
        if (busy) return;
        const name = draft.name.trim();
        if (name === '') {
            setShowNameError(true);
            return;
        }
        const payload = {
            name,
            kind: draft.kind,
            color: draft.color,
            initialBalance: parseAmount(draft.initialBalance) ?? 0,
            note: draft.note,
            archived: draft.archived
        };
        setBusy(true);
        setError(null);
        try {
            if (account) await api.send('finance.accountUpdate', { accountId: account.id, account: payload });
            else await api.send('finance.accountAdd', { account: payload });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!account || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.accountRemove', { accountId: account.id });
            onSaved();
        } catch (e) {
            // La phrase du serveur dit combien d'opérations bloquent : plus utile que le repli.
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={account ? 'Modifier le compte' : 'Nouveau compte'}
            width={520}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom</span>
                    <TextInput
                        data-autofocus='true'
                        placeholder='ex. Compte courant'
                        maxLength={FINANCE_NAME_MAX_LENGTH}
                        value={draft.name}
                        error={showNameError && draft.name.trim() === '' ? 'Nom requis' : undefined}
                        onChange={(e) => {
                            set('name', e.target.value);
                            setShowNameError(false);
                        }}
                    />
                </label>

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Nature</span>
                        <SelectInput
                            value={draft.kind}
                            onChange={(e) => set('kind', e.target.value as FinanceAccountKind)}
                        >
                            {ACCOUNT_KINDS.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {entry.label}
                                </option>
                            ))}
                        </SelectInput>
                        {draft.kind === 'savings' && (
                            <span className={styles.fieldHint}>
                                Compté à part du disponible sur le tableau de bord.
                            </span>
                        )}
                    </label>

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>{account ? 'Solde de départ' : 'Solde d’aujourd’hui'}</span>
                        <TextInput
                            inputMode='decimal'
                            placeholder='0,00'
                            value={draft.initialBalance}
                            onChange={(e) => set('initialBalance', e.target.value)}
                        />
                        <span className={styles.fieldHint}>
                            Ce qu’il y a dessus avant la première opération saisie ici. Un découvert se note avec un
                            signe moins.
                        </span>
                    </label>
                </div>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Couleur</span>
                    <div className={styles.swatches}>
                        {FINANCE_COLORS.map((color) => (
                            <button
                                key={color}
                                type='button'
                                aria-label={color}
                                aria-pressed={draft.color === color}
                                className={draft.color === color ? styles.swatchActive : styles.swatch}
                                style={{ background: colorVar(color) }}
                                onClick={() => set('color', color)}
                            />
                        ))}
                    </div>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Note (optionnel)</span>
                    <TextInput
                        placeholder='ex. IBAN, agence, usage'
                        maxLength={FINANCE_NOTE_MAX_LENGTH}
                        value={draft.note}
                        onChange={(e) => set('note', e.target.value)}
                    />
                </label>

                {account && (
                    <Checkbox checked={draft.archived} onChange={(value) => set('archived', value)}>
                        Archivé: retiré des listes de saisie, mais toujours compté dans les totaux
                    </Checkbox>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {account && base.canWrite && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : account ? 'Enregistrer' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default AccountDialog;
