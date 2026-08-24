import { useEffect, useMemo, useState } from 'react';
import type { FinanceTransaction, FinanceTransactionKind } from '@deveye/types';
import { FINANCE_COUNTERPARTY_MAX_LENGTH, FINANCE_LABEL_MAX_LENGTH, FINANCE_NOTE_MAX_LENGTH } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import { humanizeError } from './api';
import {
    TRANSACTION_KINDS,
    VAT_RATES,
    amountToInput,
    formatMoney,
    parseAmount,
    rateOfVat,
    vatFromGross
} from './format';
import { activeAccounts } from './shared';
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
    onManageCategories: () => void;
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
    vatRate: number;
    cleared: boolean;
}

/**
 * La saisie d'une opération.
 *
 * ## Le montant est toujours positif
 *
 * Le sens vient du sélecteur en tête (dépense, recette, virement) et jamais du
 * signe: un montant signé laisserait exister « une dépense de -30 € », qui est
 * une recette écrite de travers, et chaque écran devrait ensuite se demander ce
 * qu'il regarde. Changer de nature reconfigure donc le formulaire, et pas
 * seulement une étiquette.
 *
 * ## La TVA se saisit par son taux, mais se stocke en montant
 *
 * Les boutons de taux ne font que **calculer** la part de TVA d'un montant TTC.
 * C'est cette part qui part au serveur, jamais le taux: garder les deux
 * ouvrirait la porte à un couple incohérent que rien ne pourrait ensuite
 * départager, et un taux exotique (un import, un DOM) resterait saisissable en
 * modifiant le montant à la main.
 */
export function TransactionDialog({
    base,
    open,
    transaction,
    defaultAccountId,
    defaultDate,
    onClose,
    onSaved,
    onManageCategories
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
                      vatRate: rateOfVat(transaction.amount, transaction.vatAmount ?? 0) ?? 0,
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
                      vatRate: 0,
                      cleared: false
                  },
        [transaction, defaultDate, fallbackAccount]
    );

    const [draft, setDraft] = useState<Draft>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAmountError, setShowAmountError] = useState(false);

    // Repartir de zéro à chaque ouverture: un dialogue rouvert doit montrer ce
    // qu'on vient de cliquer, pas ce qu'on avait tapé la fois d'avant.
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
            vatRate: kind === 'transfer' ? 0 : previous.vatRate
        }));

    const amountCents = parseAmount(draft.amount);
    const vatCents =
        draft.kind === 'transfer' || draft.vatRate <= 0 ? null : vatFromGross(amountCents ?? 0, draft.vatRate);
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
                await ws.send('finance.transactionUpdate', { transactionId: transaction.id, transaction: payload });
            else await ws.send('finance.transactionAdd', { transaction: payload });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!transaction || busy) return;
        setBusy(true);
        setError(null);
        try {
            await ws.send('finance.transactionRemove', { transactionId: transaction.id });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setBusy(false);
        }
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
        >
            <div className={styles.form}>
                <div className={styles.segmented} role='tablist' aria-label='Nature de l’opération'>
                    {TRANSACTION_KINDS.map((entry) => (
                        <button
                            key={entry.id}
                            type='button'
                            role='tab'
                            aria-selected={entry.id === draft.kind}
                            className={entry.id === draft.kind ? styles.segmentActive : styles.segment}
                            onClick={() => setKind(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>

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
                        placeholder={draft.kind === 'income' ? 'ex. Salaire de septembre' : 'ex. Courses du samedi'}
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
                                <button type='button' className={styles.fieldLink} onClick={onManageCategories}>
                                    Aucune catégorie de {draft.kind === 'income' ? 'recettes' : 'dépenses'}: en créer
                                </button>
                            )}
                        </label>
                    )}
                </div>

                {draft.kind !== 'transfer' && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>
                            {draft.kind === 'income' ? 'Client' : 'Bénéficiaire'} (optionnel)
                        </span>
                        <TextInput
                            placeholder={draft.kind === 'income' ? 'ex. Dupont SARL' : 'ex. EDF'}
                            maxLength={FINANCE_COUNTERPARTY_MAX_LENGTH}
                            value={draft.counterparty}
                            onChange={(e) => set('counterparty', e.target.value)}
                        />
                    </label>
                )}

                {base.config.vatEnabled && draft.kind !== 'transfer' && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>TVA</span>
                        <div className={styles.chips}>
                            {VAT_RATES.map((rate) => (
                                <button
                                    key={rate}
                                    type='button'
                                    aria-pressed={draft.vatRate === rate}
                                    className={draft.vatRate === rate ? styles.chipActive : styles.chip}
                                    onClick={() => set('vatRate', rate)}
                                >
                                    {rate === 0 ? 'Aucune' : `${String(rate).replace('.', ',')} %`}
                                </button>
                            ))}
                        </div>
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
                    <span className={styles.fieldLabel}>Note (optionnel)</span>
                    <textarea
                        className={styles.textarea}
                        rows={2}
                        maxLength={FINANCE_NOTE_MAX_LENGTH}
                        value={draft.note}
                        onChange={(e) => set('note', e.target.value)}
                    />
                </label>

                <Checkbox checked={draft.cleared} onChange={(value) => set('cleared', value)}>
                    Pointée: déjà vue sur le relevé de la banque
                </Checkbox>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {transaction && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : transaction ? 'Enregistrer' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default TransactionDialog;
