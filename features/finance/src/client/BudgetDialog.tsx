import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    Dialog,
    DialogCancelButton,
    humanizeError,
    SegmentedControl,
    SelectInput,
    TextInput
} from 'deveye-sdk-client';
import type { FinanceBudget, FinanceBudgetPeriod, FinanceCategory } from '../contracts/domain';

import { api, refreshFinance } from './api';
import { BUDGET_PERIODS, amountToInput, parseAmount } from './format';
import { categoryOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface BudgetDialogProps {
    base: FinanceBase;
    open: boolean;
    /** L'enveloppe modifiée, ou `null` pour une nouvelle. */
    budget: FinanceBudget | null;
    /** Les catégories de dépenses qui n'ont pas encore d'enveloppe. */
    available: FinanceCategory[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Poser ou retirer une enveloppe.
 *
 * La catégorie ne se change pas sur une enveloppe existante: ce serait retirer
 * celle-ci et en poser une autre, en gardant l'apparence d'une modification. Le
 * sélecteur ne propose donc que les catégories libres, à la création.
 */
export function BudgetDialog({ base, open, budget, available, onClose, onSaved }: BudgetDialogProps) {
    const initial = useMemo(
        () => ({
            categoryId: budget?.categoryId ?? available[0]?.id ?? 0,
            amount: amountToInput(budget?.amount ?? 0),
            period: (budget?.period ?? 'monthly') as FinanceBudgetPeriod
        }),
        [budget, available]
    );

    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(initial);
        setError(null);
    }, [open, initial]);

    const amountCents = parseAmount(draft.amount);
    const category = categoryOf(base.categories, draft.categoryId);

    const submit = async () => {
        if (busy || draft.categoryId === 0) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.budgetSet', {
                categoryId: draft.categoryId,
                amount: Math.max(0, amountCents ?? 0),
                period: draft.period
            });
            refreshFinance();
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!budget || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.budgetRemove', { budgetId: budget.id });
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
            title={budget ? 'Modifier l’enveloppe' : 'Poser un budget'}
            width={460}
            onSubmit={() => void submit()}
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Catégorie</span>
                    {budget ? (
                        <span className={styles.fieldStatic}>{category?.name ?? 'Catégorie'}</span>
                    ) : (
                        <SelectInput
                            value={draft.categoryId}
                            onChange={(e) => setDraft((d) => ({ ...d, categoryId: Number(e.target.value) }))}
                        >
                            {available.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {entry.name}
                                </option>
                            ))}
                        </SelectInput>
                    )}
                </label>

                <div className={styles.formRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Plafond</span>
                        <TextInput
                            data-autofocus='true'
                            inputMode='decimal'
                            placeholder='0,00'
                            value={draft.amount}
                            onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                        />
                    </label>
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Période</span>
                        <SegmentedControl
                            aria-label='Période'
                            value={draft.period}
                            onChange={(v: FinanceBudgetPeriod) => setDraft((d) => ({ ...d, period: v }))}
                            options={BUDGET_PERIODS.map((entry) => ({ value: entry.id, label: entry.label }))}
                        />
                    </div>
                </div>

                <p className={styles.fieldHint}>
                    Le compteur repart à zéro au début de chaque période civile, et ne bloque jamais une saisie: une
                    enveloppe dépassée est signalée, pas interdite.
                </p>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {budget && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Retirer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy || draft.categoryId === 0}>
                    {busy ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
            </div>
        </Dialog>
    );
}

export default BudgetDialog;
