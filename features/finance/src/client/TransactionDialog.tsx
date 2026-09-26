import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    FeatureSettingsButton,
    SegmentedControl,
    SelectInput,
    TextInput,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { FinanceTransaction, FinanceTransactionKind } from '../contracts/domain';
import {
    FINANCE_COUNTERPARTY_MAX_LENGTH,
    FINANCE_LABEL_MAX_LENGTH,
    FINANCE_NOTE_MAX_LENGTH
} from '../contracts/domain';

import { api } from './api';
import {
    TRANSACTION_KINDS,
    VAT_RATES,
    amountToInput,
    formatMoney,
    parseAmount,
    rateOfVat,
    vatFromGross
} from './format';
import { activeAccounts, errorNote } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface TransactionDialogProps {
    base: FinanceBase;
    open: boolean;
    /** L'opération modifiée, ou `null` pour une saisie neuve. */
    transaction: FinanceTransaction | null;
    defaultAccountId?: number;
    defaultDate: string;
    onClose: () => void;
    onSaved: () => void;
}

/** Ce que le formulaire tient, avant conversion en centimes. */
interface Draft {
    kind: FinanceTransactionKind;
    amount: string;
    date: string;
    label: string;
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    counterparty: string;
    note: string;
    vatRate: string;
    cleared: boolean;
}

/** Les taux en texte : un segment porte une valeur-chaîne. */
const VAT_OPTIONS = VAT_RATES.map((rate) => ({
    value: String(rate),
    label: rate === 0 ? 'Aucune' : `${String(rate).replace('.', ',')} %`
}));

/**
 * La saisie d'une opération. Le montant est toujours positif : le sens vient
 * du sélecteur, pas du signe. La TVA se saisit par son taux mais se stocke en
 * montant : garder les deux ouvrirait un couple incohérent.
 */
export function TransactionDialog({
    base,
    open,
    transaction,
    defaultAccountId,
    defaultDate,
    onClose,
    onSaved
}: TransactionDialogProps) {
    const accounts = activeAccounts(base.accounts);
    const fallbackAccount = defaultAccountId ?? accounts[0]?.id ?? base.accounts[0]?.id ?? 0;

    const initial = useMemo<Draft>(
        () =>
            transaction
                ? {
                      kind: transaction.kind,
                      amount: amountToInput(transaction.amount),
                      date: transaction.date,
                      label: transaction.label,
                      accountId: transaction.accountId,
                      transferAccountId: transaction.transferAccountId,
                      categoryId: transaction.categoryId,
                      counterparty: transaction.counterparty,
                      note: transaction.note,
                      vatRate: String(rateOfVat(transaction.amount, transaction.vatAmount ?? 0) ?? 0),
                      cleared: transaction.cleared
                  }
                : {
                      kind: 'expense',
                      amount: '',
                      date: defaultDate,
                      label: '',
                      accountId: fallbackAccount,
                      transferAccountId: null,
                      categoryId: null,
                      counterparty: '',
                      note: '',
                      vatRate: '0',
                      cleared: false
                  },
        [transaction, defaultDate, fallbackAccount]
    );

    const [draft, setDraft] = useState<Draft>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [showAmountError, setShowAmountError] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    // Repartir de zéro à chaque ouverture : un dialogue rouvert montre ce qu'on
    // vient de cliquer, pas ce qu'on avait tapé la fois d'avant.
    useEffect(() => {
        if (!open) return;
        setDraft(initial);
        setError(null);
        setShowAmountError(false);
    }, [open, initial]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

    /** Changer de nature invalide ce qui n'a plus de sens dans la nouvelle. */
    const setKind = (kind: FinanceTransactionKind) =>
        setDraft((previous) => ({
            ...previous,
            kind,
            categoryId: kind === 'transfer' ? null : previous.categoryId,
            transferAccountId: kind === 'transfer' ? previous.transferAccountId : null,
            vatRate: kind === 'transfer' ? '0' : previous.vatRate
        }));

    const amountCents = parseAmount(draft.amount);
    const rate = Number(draft.vatRate);
    const vatCents = draft.kind === 'transfer' || rate <= 0 ? null : vatFromGross(amountCents ?? 0, rate);
    const categories = base.categories.filter((category) => category.flow === draft.kind);
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

    const submit = async () => {
        if (busy) return;
        if (amountCents === null || amountCents <= 0) {
            setShowAmountError(true);
            return;
        }
        const payload = {
            accountId: draft.accountId,
            kind: draft.kind,
            amount: amountCents,
            date: draft.date,
            label: draft.label.trim(),
            categoryId: draft.kind === 'transfer' ? null : draft.categoryId,
            transferAccountId: draft.kind === 'transfer' ? draft.transferAccountId : null,
            counterparty: draft.counterparty.trim(),
            note: draft.note,
            vatAmount: vatCents !== null && vatCents > 0 ? vatCents : null,
            cleared: draft.cleared
        };
        setBusy(true);
        setError(null);
        try {
            if (transaction)
                await api.send('finance.transactionUpdate', { transactionId: transaction.id, transaction: payload });
            else await api.send('finance.transactionAdd', { transaction: payload });
            onSaved();
        } catch (e) {
            setError(errorNote(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const askRemove = () => {
        if (!transaction) return;
        setConfirm({
            title: 'Supprimer cette opération ?',
            description: 'Les soldes des comptes qu’elle touche seront recalculés sans elle.',
            confirmLabel: 'Supprimer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('finance.transactionRemove', { transactionId: transaction.id });
                        onSaved();
                    } catch (e) {
                        setError(errorNote(e, 'Suppression impossible.'));
                    } finally {
                        setBusy(false);
                        setConfirm(null);
                    }
                })();
            }
        });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={transaction ? 'Modifier l’opération' : 'Nouvelle opération'}
            width={560}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
            footer={
                <>
                    {transaction && (
                        <Button variant='danger' className={styles.footerStart} onClick={askRemove} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : transaction ? 'Enregistrer' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <SegmentedControl
                    aria-label='Nature de l’opération'
                    fullWidth
                    value={draft.kind}
                    options={TRANSACTION_KINDS.map((entry) => ({ value: entry.id, label: entry.label }))}
                    onChange={setKind}
                />

                <div className={styles.formRow}>
                    <label className={styles.fieldWide}>
                        <span className={styles.fieldLabel}>Montant</span>
                        <TextInput
                            data-autofocus='true'
                            inputMode='decimal'
                            placeholder='0,00'
                            className={styles.amountInput}
                            value={draft.amount}
                            error={
                                showAmountError && (amountCents === null || amountCents <= 0)
                                    ? 'Montant requis'
                                    : undefined
                            }
                            onChange={(e) => {
                                set('amount', e.target.value);
                                setShowAmountError(false);
                            }}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Date</span>
                        <TextInput type='date' value={draft.date} onChange={(e) => set('date', e.target.value)} />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Intitulé</span>
                    <TextInput
                        placeholder={
                            draft.kind === 'income' ? 'ex. Acompte du site vitrine' : 'ex. Hébergement d’octobre'
                        }
                        maxLength={FINANCE_LABEL_MAX_LENGTH}
                        value={draft.label}
                        onChange={(e) => set('label', e.target.value)}
                    />
                </label>

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>
                            {draft.kind === 'transfer' ? 'Depuis le compte' : 'Compte'}
                        </span>
                        <SelectInput value={draft.accountId} onChange={(e) => set('accountId', Number(e.target.value))}>
                            {base.accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                    {account.name}
                                    {account.archived ? ' (archivé)' : ''}
                                </option>
                            ))}
                        </SelectInput>
                    </label>

                    {draft.kind === 'transfer' ? (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Vers le compte</span>
                            <SelectInput
                                value={draft.transferAccountId ?? ''}
                                onChange={(e) =>
                                    set('transferAccountId', e.target.value === '' ? null : Number(e.target.value))
                                }
                            >
                                <option value=''>Choisir…</option>
                                {base.accounts
                                    .filter((account) => account.id !== draft.accountId)
                                    .map((account) => (
                                        <option key={account.id} value={account.id}>
                                            {account.name}
                                        </option>
                                    ))}
                            </SelectInput>
                        </label>
                    ) : (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Catégorie</span>
                            <SelectInput
                                value={draft.categoryId ?? ''}
                                onChange={(e) =>
                                    set('categoryId', e.target.value === '' ? null : Number(e.target.value))
                                }
                            >
                                <option value=''>Sans catégorie</option>
                                {categories.map((category) => (
                                    <option key={category.id} value={category.id}>
                                        {category.name}
                                    </option>
                                ))}
                            </SelectInput>
                            {categories.length === 0 && (
                                <span className={styles.fieldHint}>
                                    Aucune catégorie de {draft.kind === 'income' ? 'recettes' : 'dépenses'} :{' '}
                                    <FeatureSettingsButton
                                        scope={{ kind: 'feature', feature: 'finance' }}
                                        initialSection='categories'
                                        variant='link'
                                        label='en créer'
                                    />
                                    .
                                </span>
                            )}
                        </label>
                    )}
                </div>

                {draft.kind !== 'transfer' && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>
                            {draft.kind === 'income' ? 'Client' : 'Fournisseur'} (facultatif)
                        </span>
                        <TextInput
                            placeholder={draft.kind === 'income' ? 'ex. Dupont SARL' : 'ex. OVHcloud'}
                            maxLength={FINANCE_COUNTERPARTY_MAX_LENGTH}
                            value={draft.counterparty}
                            onChange={(e) => set('counterparty', e.target.value)}
                        />
                    </label>
                )}

                {base.config.vatEnabled && draft.kind !== 'transfer' && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>TVA</span>
                        <SegmentedControl
                            aria-label='Taux de TVA'
                            value={draft.vatRate}
                            options={VAT_OPTIONS}
                            onChange={(value) => set('vatRate', value)}
                        />
                        <span className={styles.fieldHint}>
                            {vatCents === null || vatCents === 0
                                ? 'Le montant saisi est le montant total, TVA comprise.'
                                : `Soit ${formatMoney(vatCents, base.config.currency)} de TVA sur ${formatMoney(
                                      amountCents ?? 0,
                                      base.config.currency
                                  )} TTC.`}
                        </span>
                    </div>
                )}

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Note (facultatif)</span>
                    <textarea
                        className={styles.textarea}
                        rows={2}
                        maxLength={FINANCE_NOTE_MAX_LENGTH}
                        value={draft.note}
                        onChange={(e) => set('note', e.target.value)}
                    />
                </label>

                <Checkbox checked={draft.cleared} onChange={(value) => set('cleared', value)}>
                    Pointée : déjà vue sur le relevé de la banque
                </Checkbox>

                <ErrorNote note={error} />
            </div>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </Dialog>
    );
}

export default TransactionDialog;
