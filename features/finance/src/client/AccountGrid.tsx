import { useState } from 'react';
import { ErrorNote, useDragReorder, type ErrorNoteInput } from 'deveye-sdk-client';
import type { FinanceAccount } from '../contracts/domain';

import { api, refreshFinance } from './api';
import { accountKindIcon, accountKindLabel, formatMoney } from './format';
import { colorVar, errorNote } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface AccountGridProps {
    base: FinanceBase;
    onOpen: (accountId: number) => void;
}

/**
 * Les comptes en cartes : le solde d'un coup d'œil, un clic pour la fiche. Les
 * archivés suivent, atténués : ils restent dans le total, archiver ne fait pas
 * disparaître l'argent.
 */
export function AccountGrid({ base, onOpen }: AccountGridProps) {
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const active = base.accounts.filter((account) => !account.archived);
    const archived = base.accounts.filter((account) => account.archived);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: active.map((account) => account.id),
        rowSelector: '[data-account-card]',
        layout: 'grid',
        onReorder: (ids) => {
            // Les archivés gardent leur rang : seul l'ordre des vivants bouge.
            const next = [...(ids as number[]), ...archived.map((account) => account.id)];
            api.send('finance.accountReorder', { accountIds: next })
                .then(() => refreshFinance())
                .catch((e: unknown) => setError(errorNote(e, 'Réorganisation impossible.')));
        }
    });

    const card = (account: FinanceAccount, draggable: boolean) => (
        <div
            key={account.id}
            data-account-card=''
            className={`${styles.accountCard} ${drag.draggingId === account.id ? styles.accountDragging : ''}`}
            data-archived={account.archived ? 'true' : undefined}
            style={{ '--account-color': colorVar(account.color) } as React.CSSProperties}
        >
            <button type='button' className={styles.accountOpen} onClick={() => onOpen(account.id)}>
                <span className={styles.accountHead}>
                    <span
                        className={`icon icon-${accountKindIcon(account.kind)} ${styles.accountIcon}`}
                        aria-hidden='true'
                    />
                    <span className={styles.accountName}>{account.name}</span>
                </span>
                <span className={styles.accountBalance} data-negative={account.balance < 0 ? 'true' : undefined}>
                    {formatMoney(account.balance, base.config.currency)}
                </span>
                <span className={styles.accountMeta}>
                    {accountKindLabel(account.kind)} · {account.transactionCount} opération
                    {account.transactionCount > 1 ? 's' : ''}
                </span>
            </button>
            {base.canWrite && draggable && active.length > 1 && (
                <span
                    className={`icon icon-drag ${styles.grip}`}
                    role='button'
                    tabIndex={-1}
                    aria-label={`Déplacer ${account.name}`}
                    onPointerDown={(e) => drag.onGripPointerDown(e, account.id)}
                />
            )}
        </div>
    );

    return (
        <>
            <ErrorNote note={error} />
            <div ref={drag.listRef} className={styles.accountGrid}>
                {active.map((account) => card(account, true))}
                <span ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
            </div>
            {archived.length > 0 && (
                <>
                    <h4 className={styles.archivedHead}>Archivés</h4>
                    <div className={styles.accountGrid}>{archived.map((account) => card(account, false))}</div>
                </>
            )}
        </>
    );
}

export default AccountGrid;
