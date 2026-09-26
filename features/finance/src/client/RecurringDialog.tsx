import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    NumberInput,
    SegmentedControl,
    SelectInput,
    TextInput,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
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
import { activeAccounts, errorNote } from './shared';
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
    vatRate: string;
    frequency: FinanceFrequency;
    interval: number;
    nextDate: string;
    endDate: string;
    automatic: boolean;
    active: boolean;
}

const VAT_OPTIONS = VAT_RATES.map((rate) => ({
    value: String(rate),
    label: rate === 0 ? 'Aucune' : `${String(rate).replace('.', ',')} %`
}));

/**
 * La prochaine date fixe le jour d'ancrage de la série : une échéance au 31
 * revient au 31, y compris après un février.
 */
export function RecurringDialog({ base, open, recurring, onClose, onSaved }: RecurringDialogProps) {
    const initial = useMemo<Draft>(
        () => ({
            kind: recurring?.kind ?? 'expense',
            amount: recurring ? amountToInput(recurring.amount) : '',
            label: recurring?.label ?? '',
            accountId: recurring?.accountId ?? activeAccounts(base.accounts)[0]?.id ?? 0,
            transferAccountId: recurring?.transferAccountId ?? null,
            categoryId: recurring?.categoryId ?? null,
            counterparty: recurring?.counterparty ?? '',
            note: recurring?.note ?? '',
            vatRate: String(recurring ? (rateOfVat(recurring.amount, recurring.vatAmount ?? 0) ?? 0) : 0),
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
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [showAmountError, setShowAmountError] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(initial);
        setError(null);
        setShowAmountError(false);
    }, [open, initial]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((previous) => ({ ...previous, [key]: value }));

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
    // Une manuelle peut partir de zéro : son montant se corrige à chaque fois.
    const amountMissing = amountCents === null || amountCents < 0 || (draft.automatic && amountCents === 0);

    const submit = async () => {
        if (busy || draft.accountId === 0) return;
        if (amountCents === null || amountMissing) {
            setShowAmountError(true);
            return;
        }
        const payload = {
            accountId: draft.accountId,
            kind: draft.kind,
            amount: amountCents,
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
            setError(errorNote(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const askRemove = () => {
        if (!recurring) return;
        setConfirm({
            title: 'Supprimer cette échéance ?',
            description:
                'Rien ne sera plus écrit ni proposé. Les opérations qu’elle a déjà écrites restent : elles ont eu lieu.',
            confirmLabel: 'Supprimer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('finance.recurringRemove', { recurringId: recurring.id });
                        refreshFinance();
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
            title={recurring ? 'Modifier l’échéance' : 'Nouvelle échéance'}
            width={560}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
            footer={
                <>
                    {recurring && (
                        <Button variant='danger' className={styles.footerStart} onClick={askRemove} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                    <DialogCancelButton>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy || draft.accountId === 0}>
                        {busy ? 'Enregistrement…' : recurring ? 'Enregistrer' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <SegmentedControl
                    aria-label='Nature'
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
                            error={showAmountError && amountMissing ? 'Montant requis' : undefined}
                            onChange={(e) => {
                                set('amount', e.target.value);
                                setShowAmountError(false);
                            }}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Prochaine fois</span>
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
                        placeholder='ex. Serveur dédié'
                        maxLength={FINANCE_LABEL_MAX_LENGTH}
                        value={draft.label}
                        onChange={(e) => set('label', e.target.value)}
                    />
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Cadence</span>
                    <SegmentedControl
                        aria-label='Cadence'
                        value={draft.frequency}
                        onChange={(value: FinanceFrequency) => set('frequency', value)}
                        options={FREQUENCIES.map((entry) => ({ value: entry.id, label: entry.label }))}
                    />
                </div>

                <div className={styles.formRow}>
                    <label className={styles.field} htmlFor='finance-recurring-interval'>
                        <span className={styles.fieldLabel}>Tous les</span>
                        <NumberInput
                            id='finance-recurring-interval'
                            value={draft.interval}
                            min={1}
                            max={60}
                            onChange={(value) => set('interval', value ?? 1)}
                        />
                        <span className={styles.fieldHint}>{frequencyLabel(draft.frequency, draft.interval)}</span>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Jusqu’au (facultatif)</span>
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
                            {draft.kind === 'income' ? 'Client' : 'Fournisseur'} (facultatif)
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
                        <SegmentedControl
                            aria-label='Taux de TVA'
                            value={draft.vatRate}
                            options={VAT_OPTIONS}
                            onChange={(value) => set('vatRate', value)}
                        />
                        {vatCents !== null && vatCents > 0 && (
                            <span className={styles.fieldHint}>
                                Soit {formatMoney(vatCents, base.config.currency)} de TVA à chaque fois.
                            </span>
                        )}
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

                <Checkbox checked={draft.automatic} onChange={(value) => set('automatic', value)}>
                    L’enregistrer toute seule le jour venu
                </Checkbox>
                <span className={styles.fieldHint}>
                    {draft.automatic
                        ? 'Écrite seule, au montant indiqué. À réserver à ce qui ne varie pas : loyer, abonnement, serveur.'
                        : 'Proposée le jour venu : vous corrigez son montant, puis vous l’enregistrez.'}
                </span>

                {recurring && (
                    <Checkbox checked={!draft.active} onChange={(value) => set('active', !value)}>
                        Suspendue : plus rien n’est écrit ni proposé
                    </Checkbox>
                )}

                <ErrorNote note={error} />
            </div>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </Dialog>
    );
}

export default RecurringDialog;
