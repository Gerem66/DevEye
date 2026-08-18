import { useState } from 'react';
import type { FinanceAccount } from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { useDragReorder } from '@/dragReorder';

import AccountDialog from './AccountDialog';
import { humanizeError, refreshFinance } from './api';
import { accountKindIcon, accountKindLabel, formatMoney } from './format';
import { colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface AccountsProps {
    base: FinanceBase;
}

/**
 * Les comptes, et leurs soldes.
 *
 * ## Trois soldes par carte, et pourquoi les trois
 *
 * `balance` est le solde, sans autre qualificatif: ce qu'il y a aujourd'hui.
 * `projected` le complète des opérations déjà saisies pour plus tard (un loyer
 * prélevé le 5, noté le 2), et n'est montré que s'il diffère. `cleared` ne compte
 * que ce qui a été **pointé**: c'est le seul qu'on puisse comparer à un relevé
 * bancaire, et les confondre est la source d'erreur la plus courante d'un livre
 * de comptes.
 *
 * ## Les archivés restent dans le total
 *
 * Archiver range un compte, cela ne fait pas disparaître ce qu'il contient. Le
 * total en tête couvre donc tout ce qui est affiché ici, archivés compris, et
 * c'est aussi ce qu'annonce le tableau de bord.
 */
export function Accounts({ base }: AccountsProps) {
    const [dialog, setDialog] = useState<{ account: FinanceAccount | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const active = base.accounts.filter((account) => !account.archived);
    const archived = base.accounts.filter((account) => account.archived);
    const total = base.accounts.reduce((sum, account) => sum + account.balance, 0);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: active.map((account) => account.id),
        rowSelector: '[data-account-card]',
        layout: 'grid',
        onReorder: (ids) => {
            // Les archivés gardent leur rang: seul l'ordre des vivants se
            // déplace, et ils sont de toute façon rendus après.
            const next = [...(ids as number[]), ...archived.map((account) => account.id)];
            ws.send('finance.accountReorder', { accountIds: next })
                .then(() => refreshFinance())
                .catch((e: unknown) => setError(humanizeError(e, 'Réorganisation impossible.')));
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
            <div className={styles.accountHead}>
                <span className={`icon icon-${accountKindIcon(account.kind)} ${styles.accountIcon}`} />
                <span className={styles.accountName}>{account.name}</span>
                {base.canWrite && draggable && (
                    <span
                        className={`icon icon-drag ${styles.grip}`}
                        role='button'
                        tabIndex={-1}
                        aria-label='Déplacer'
                        onPointerDown={(e) => drag.onGripPointerDown(e, account.id)}
                    />
                )}
                {base.canWrite && (
                    <button
                        type='button'
                        className={styles.accountEdit}
                        aria-label={`Modifier ${account.name}`}
                        onClick={() => setDialog({ account })}
                    >
                        <span className='icon icon-edit' />
                    </button>
                )}
            </div>

            <span className={styles.accountBalance} data-negative={account.balance < 0 ? 'true' : undefined}>
                {formatMoney(account.balance, base.config.currency)}
            </span>

            <div className={styles.accountMeta}>
                <span>{accountKindLabel(account.kind)}</span>
                <span>
                    {account.transactionCount} opération{account.transactionCount > 1 ? 's' : ''}
                </span>
            </div>

            <div className={styles.accountFoot}>
                {account.projected !== account.balance && (
                    <span title='En tenant compte des opérations déjà datées plus tard'>
                        À venir {formatMoney(account.projected, base.config.currency)}
                    </span>
                )}
                {account.cleared !== account.balance && (
                    <span title='Seulement les opérations pointées, à comparer au relevé'>
                        Pointé {formatMoney(account.cleared, base.config.currency)}
                    </span>
                )}
                {account.note && <span className={styles.accountNote}>{account.note}</span>}
            </div>
        </div>
    );

    return (
        <div className={styles.accounts}>
            <div className={styles.accountsHead}>
                <div>
                    <span className={styles.accountsTotalLabel}>Solde total</span>
                    <span className={styles.accountsTotal} data-negative={total < 0 ? 'true' : undefined}>
                        {formatMoney(total, base.config.currency)}
                    </span>
                </div>
                {base.canWrite && (
                    <Button icon='plus' onClick={() => setDialog({ account: null })}>
                        Ajouter un compte
                    </Button>
                )}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {base.accounts.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-finance ${styles.emptyIcon}`} />
                    <h3 className={styles.emptyTitle}>Aucun compte</h3>
                    <p className={styles.emptyText}>
                        Indiquez le solde d’aujourd’hui de votre compte: c’est le point de départ du livre, et tous les
                        soldes suivants s’en déduisent.
                    </p>
                </div>
            ) : (
                <>
                    <div ref={drag.listRef} className={styles.accountGrid}>
                        {active.map((account) => card(account, true))}
                        <span ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
                    </div>

                    {archived.length > 0 && (
                        <section className={styles.archived}>
                            <h4 className={styles.archivedHead}>
                                Archivés
                                <span className={styles.archivedHint}>rangés, mais toujours comptés dans le total</span>
                            </h4>
                            <div className={styles.accountGrid}>{archived.map((account) => card(account, false))}</div>
                        </section>
                    )}
                </>
            )}

            <AccountDialog
                base={base}
                open={dialog !== null}
                account={dialog?.account ?? null}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null);
                    base.reloadBase();
                    refreshFinance();
                }}
            />
        </div>
    );
}

export default Accounts;
