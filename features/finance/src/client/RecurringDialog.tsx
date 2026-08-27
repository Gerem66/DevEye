import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, DialogCancelButton, humanizeError, SelectInput, TextInput } from 'deveye-sdk-client';
import type { FinanceFrequency, FinanceRecurring, FinanceTransactionKind } from '../contracts/domain';
import {
    FINANCE_COUNTERPARTY_MAX_LENGTH,
    FINANCE_LABEL_MAX_LENGTH,
    FINANCE_NOTE_MAX_LENGTH
} from '../contracts/domain';

import { api, refreshFinance } from './api';
import {
    FREQUENCIES,
    TRANSACTION_KINDS,
    VAT_RATES,
    amountToInput,
    formatMoney,
    frequencyLabel,
    parseAmount,
    rateOfVat,
    todayIso,
    vatFromGross
} from './format';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface RecurringDialogProps {
    base: FinanceBase;
    open: boolean;
    recurring: FinanceRecurring | null;
    onClose: () => void;
    onSaved: () => void;
}

interface Draft {
    kind: FinanceTransactionKind;
    amount: string;
    label: string;
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    counterparty: string;
    note: string;
    vatRate: number;
    frequency: FinanceFrequency;
    interval: number;
    nextDate: string;
    endDate: string;
    automatic: boolean;
    active: boolean;
}

/**
 * Le réglage d'une échéance.
 *
 * La **prochaine date** est le champ qui décide de tout: c'est elle qui fixe le
 * jour d'ancrage de la série. Une échéance posée au 31 revient au 31 tous les
 * mois, y compris après un février, ce que le serveur garantit en gardant ce
 * jour à part plutôt qu'en repartant de la dernière date écrite.
 */
export function RecurringDialog({ base, open, recurring, onClose, onSaved }: RecurringDialogProps) {
    const initial = useMemo<Draft>(
        () => ({
            kind: recurring?.kind ?? 'expense',
            amount: amountToInput(recurring?.amount ?? 0),
            label: recurring?.label ?? '',
            accountId: recurring?.accountId ?? base.accounts.find((a) => !a.archived)?.id ?? 0,
            transferAccountId: recurring?.transferAccountId ?? null,
            categoryId: recurring?.categoryId ?? null,
            counterparty: recurring?.counterparty ?? '',
            note: recurring?.note ?? '',
            vatRate: recurring ? (rateOfVat(recurring.amount, recurring.vatAmount ?? 0) ?? 0) : 0,
            frequency: recurring?.frequency ?? 'monthly',
            interval: recurring?.interval ?? 1,
            nextDate: recurring?.nextDate ?? todayIso(),
            endDate: recurring?.endDate ?? '',
            automatic: recurring?.automatic ?? false,
            active: recurring?.active ?? true
        }),
        [recurring, base.accounts]
    );

    const [draft, setDraft] = useState<Draft>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(initial);
        setError(null);
    }, [open, initial]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

    const setKind = (kind: FinanceTransactionKind) =>
        setDraft((previous) => ({
            ...previous,
            kind,
            categoryId: kind === 'transfer' ? null : previous.categoryId,
            transferAccountId: kind === 'transfer' ? previous.transferAccountId : null,
            vatRate: kind === 'transfer' ? 0 : previous.vatRate
        }));

    const amountCents = parseAmount(draft.amount) ?? 0;
    const vatCents = draft.kind === 'transfer' || draft.vatRate <= 0 ? null : vatFromGross(amountCents, draft.vatRate);
    const categories = base.categories.filter((category) => category.flow === draft.kind);
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

    const submit = async () => {
        if (busy || draft.accountId === 0) return;
        const payload = {
            accountId: draft.accountId,
            kind: draft.kind,
            amount: Math.max(0, amountCents),
            label: draft.label.trim(),
            categoryId: draft.kind === 'transfer' ? null : draft.categoryId,
            transferAccountId: draft.kind === 'transfer' ? draft.transferAccountId : null,
            counterparty: draft.counterparty.trim(),
            note: draft.note,
            vatAmount: vatCents !== null && vatCents > 0 ? vatCents : null,
            frequency: draft.frequency,
            interval: draft.interval,
            nextDate: draft.nextDate,
            endDate: draft.endDate === '' ? null : draft.endDate,
            automatic: draft.automatic,
            active: draft.active
        };
        setBusy(true);
        setError(null);
        try {
            if (recurring) await api.send('finance.recurringUpdate', { recurringId: recurring.id, recurring: payload });
            else await api.send('finance.recurringAdd', { recurring: payload });
            refreshFinance();
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!recurring || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.recurringRemove', { recurringId: recurring.id });
            refreshFinance();
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
            title={recurring ? 'Modifier l’échéance' : 'Nouvelle échéance'}
            width={560}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
        >
            <div className={styles.form}>
                <div className={styles.segmented} role='tablist' aria-label='Nature'>
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
                            onChange={(e) => set('amount', e.target.value)}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Prochaine occurrence</span>
                        <TextInput
                            type='date'
                            value={draft.nextDate}
                            onChange={(e) => set('nextDate', e.target.value)}
                        />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Intitulé</span>
                    <TextInput
                        placeholder='ex. Loyer'
                        maxLength={FINANCE_LABEL_MAX_LENGTH}
                        value={draft.label}
                        onChange={(e) => set('label', e.target.value)}
                    />
                </label>

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Cadence</span>
                        <SelectInput
                            value={draft.frequency}
                            onChange={(e) => set('frequency', e.target.value as FinanceFrequency)}
                        >
                            {FREQUENCIES.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {entry.label}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Tous les</span>
                        <TextInput
                            type='number'
                            min={1}
                            max={60}
                            value={draft.interval}
                            onChange={(e) => set('interval', Math.min(60, Math.max(1, Number(e.target.value) || 1)))}
                        />
                        <span className={styles.fieldHint}>{frequencyLabel(draft.frequency, draft.interval)}</span>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Fin (optionnel)</span>
                        <TextInput type='date' value={draft.endDate} onChange={(e) => set('endDate', e.target.value)} />
                    </label>
                </div>

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
                        </label>
                    )}
                </div>

                {draft.kind !== 'transfer' && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>
                            {draft.kind === 'income' ? 'Client' : 'Bénéficiaire'} (optionnel)
                        </span>
                        <TextInput
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
                        {vatCents !== null && vatCents > 0 && (
                            <span className={styles.fieldHint}>
                                Soit {formatMoney(vatCents, base.config.currency)} de TVA par occurrence.
                            </span>
                        )}
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

                <Checkbox checked={draft.automatic} onChange={(value) => set('automatic', value)}>
                    Enregistrer automatiquement le jour venu
                </Checkbox>
                <span className={styles.fieldHint}>
                    {draft.automatic
                        ? 'L’opération sera écrite seule, au montant indiqué. À réserver à ce qui ne varie pas: loyer, salaire, abonnement.'
                        : 'L’occurrence vous sera proposée, et vous pourrez corriger son montant avant de l’enregistrer.'}
                </span>

                <Checkbox checked={draft.active} onChange={(value) => set('active', value)}>
                    Active
                </Checkbox>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {recurring && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy || draft.accountId === 0}>
                    {busy ? 'Enregistrement…' : recurring ? 'Enregistrer' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default RecurringDialog;
