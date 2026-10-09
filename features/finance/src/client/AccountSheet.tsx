import { Button, FeatureSettingsButton, StatusBadge, StickyHeader, useResource } from 'deveye-sdk-client';
import type { FinanceTransaction } from '../contracts/domain';

import Journal from './Journal';
import { api } from './api';
import { accountKindLabel, formatMoney } from './format';
import { accountOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface AccountSheetProps {
    base: FinanceBase;
    accountId: number;
    onBack: () => void;
    /** Le compte n'est plus là (retiré depuis ses réglages) : la fiche s'en va. */
    onGone: () => void;
    onNewTransaction: (accountId: number) => void;
    onImport: (accountId: number) => void;
    onEdit: (transaction: FinanceTransaction) => void;
}

/**
 * La fiche d'un compte : ses soldes, puis ses opérations. Son identité se
 * règle dans l'onglet Général de ses réglages, au bout de la rangée d'en-tête.
 */
export function AccountSheet({
    base,
    accountId,
    onBack,
    onGone,
    onNewTransaction,
    onImport,
    onEdit
}: AccountSheetProps) {
    const account = accountOf(base.accounts, accountId);
    const currency = base.config.currency;
    const { data: banking } = useResource(
        'finance.connectionList',
        () => api.send('finance.connectionList', {}),
        'Chargement impossible.'
    );
    const link = banking?.links.find((entry) => entry.accountId === accountId) ?? null;
    const connection = link === null ? null : (banking?.connections.find((c) => c.id === link.connectionId) ?? null);

    if (account === null) {
        return (
            <div className={styles.page}>
                <header className={styles.pageHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Accueil
                    </Button>
                </header>
                <p className={styles.placeholder}>Ce compte n’existe plus.</p>
            </div>
        );
    }

    return (
        <div className={styles.page}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.detailHead}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Accueil
                        </Button>
                        <div className={styles.ident}>
                            <h2 className={styles.heading}>{account.name}</h2>
                            <p className={styles.subheading}>
                                {account.archived && (
                                    <StatusBadge tone='neutral' dot={false}>
                                        Archivé
                                    </StatusBadge>
                                )}
                                {connection !== null && connection.status !== 'ok' && (
                                    <StatusBadge tone='warning' dot={false}>
                                        {connection.status === 'expired' ? 'Banque à reconnecter' : 'Relève en échec'}
                                    </StatusBadge>
                                )}
                                {accountKindLabel(account.kind)}
                                {connection && ` · relevé par ${connection.label}`}
                                {account.note && ` · ${account.note}`}
                            </p>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        {base.canWrite && !account.archived && (
                            <>
                                <Button variant='secondary' icon='file' onClick={() => onImport(account.id)}>
                                    Importer
                                </Button>
                                <Button icon='add' onClick={() => onNewTransaction(account.id)}>
                                    Opération
                                </Button>
                            </>
                        )}
                        <FeatureSettingsButton
                            scope={{
                                kind: 'item',
                                feature: 'finance',
                                itemId: String(account.id),
                                itemLabel: account.name
                            }}
                            onGone={onGone}
                        />
                    </div>
                </header>
            </StickyHeader>

            <dl className={styles.figures}>
                <div className={`${styles.figure} ${account.balance < 0 ? styles.figureBad : ''}`}>
                    <dt>Solde</dt>
                    <dd>{formatMoney(account.balance, currency)}</dd>
                    <p className={styles.figureNote}>Aujourd’hui</p>
                </div>
                {account.projected !== account.balance && (
                    <div className={styles.figure}>
                        <dt>À venir</dt>
                        <dd>{formatMoney(account.projected, currency)}</dd>
                        <p className={styles.figureNote}>Avec les opérations déjà datées plus tard</p>
                    </div>
                )}
                <div className={styles.figure}>
                    <dt>Pointé</dt>
                    <dd>{formatMoney(account.cleared, currency)}</dd>
                    <p className={styles.figureNote}>Ce qui a été vu sur le relevé, à comparer avec la banque</p>
                </div>
                <div className={styles.figure}>
                    <dt>Solde de départ</dt>
                    <dd>{formatMoney(account.initialBalance, currency)}</dd>
                    <p className={styles.figureNote}>Avant la première opération saisie ici</p>
                </div>
            </dl>

            <Journal base={base} accountId={account.id} onEdit={onEdit} />
        </div>
    );
}

export default AccountSheet;
