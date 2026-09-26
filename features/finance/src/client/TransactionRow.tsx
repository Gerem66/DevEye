import { useState } from 'react';
import type { ErrorNoteInput } from 'deveye-sdk-client';
import type { FinanceTransaction } from '../contracts/domain';

import { api, refreshFinance } from './api';
import { formatMoney } from './format';
import { accountName, categoryOf, colorVar, errorNote, flowOf, signOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface TransactionRowProps {
    base: FinanceBase;
    row: FinanceTransaction;
    busy: boolean;
    onToggleCleared: (row: FinanceTransaction) => void;
    onOpen: (row: FinanceTransaction) => void;
}

/**
 * Une opération : la case de pointage, puis la ligne qui ouvre sa fiche. La
 * case se clique seule, sans ouvrir quoi que ce soit.
 */
export function TransactionRow({ base, row, busy, onToggleCleared, onOpen }: TransactionRowProps) {
    const category = categoryOf(base.categories, row.categoryId);
    const currency = base.config.currency;
    const meta =
        row.kind === 'transfer'
            ? `${accountName(base.accounts, row.accountId)} vers ${accountName(base.accounts, row.transferAccountId)}`
            : [accountName(base.accounts, row.accountId), category?.name, row.counterparty].filter(Boolean).join(' · ');

    return (
        <div className={styles.row}>
            <button
                type='button'
                className={styles.rowClear}
                title={
                    row.cleared ? 'Pointée : vue sur le relevé. Cliquer pour dépointer.' : 'Pointer : vue sur le relevé'
                }
                aria-label={row.cleared ? 'Dépointer' : 'Pointer'}
                aria-pressed={row.cleared}
                disabled={!base.canWrite || busy}
                onClick={() => onToggleCleared(row)}
            >
                <span className={`icon icon-${row.cleared ? 'square-check' : 'square-empty'}`} aria-hidden='true' />
            </button>

            <button type='button' className={styles.rowBody} disabled={!base.canWrite} onClick={() => onOpen(row)}>
                <span
                    className={`icon icon-${row.kind === 'transfer' ? 'move-to-right' : (category?.icon ?? 'other')} ${styles.rowIcon}`}
                    style={{ color: category ? colorVar(category.color) : undefined }}
                    aria-hidden='true'
                />
                <span className={styles.rowText}>
                    <span className={styles.rowLabel}>
                        <span className={styles.rowLabelText}>{row.label || 'Sans intitulé'}</span>
                        {row.recurringId !== null && (
                            <span
                                className={`icon icon-clock ${styles.rowBadge}`}
                                title='Écrite par une échéance'
                                aria-label='Écrite par une échéance'
                            />
                        )}
                    </span>
                    <span className={styles.rowMeta}>{meta}</span>
                </span>
                <span className={styles.rowAmount} data-flow={flowOf(row.kind)}>
                    {signOf(row.kind)}
                    {formatMoney(row.amount, currency)}
                    {base.config.vatEnabled && row.vatAmount !== null && (
                        <span className={styles.rowVat}>dont {formatMoney(row.vatAmount, currency)} de TVA</span>
                    )}
                </span>
            </button>
        </div>
    );
}

/** Le pointage d'une ligne, commun à toutes les listes d'opérations. */
export function useClearedToggle(): {
    busy: boolean;
    error: ErrorNoteInput | null;
    toggle: (row: FinanceTransaction) => void;
} {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const toggle = (row: FinanceTransaction) => {
        setBusy(true);
        api.send('finance.transactionSetCleared', { transactionIds: [row.id], cleared: !row.cleared })
            .then(() => {
                setError(null);
                refreshFinance();
            })
            .catch((e: unknown) => setError(errorNote(e, 'Pointage impossible.')))
            .finally(() => setBusy(false));
    };

    return { busy, error, toggle };
}

export default TransactionRow;
