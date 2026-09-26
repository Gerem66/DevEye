import { useCallback, useState, type ReactNode } from 'react';
import { Button, ErrorNote, FeatureSettingsButton, SegmentedControl, useResource } from 'deveye-sdk-client';
import type { FinanceOverview, FinanceRange, FinanceTransaction } from '../contracts/domain';

import AccountGrid from './AccountGrid';
import CategoryBars from './Charts/CategoryBars';
import FlowChart from './Charts/FlowChart';
import TransactionRow, { useClearedToggle } from './TransactionRow';
import { api } from './api';
import { RANGES, formatDate, formatMoney, formatRelativeDay, formatSigned } from './format';
import { accountName, flowOf, signOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface HomeProps {
    base: FinanceBase;
    onOpenAccount: (accountId: number) => void;
    onOpenTransactions: () => void;
    onOpenRecurring: () => void;
    onNewAccount: () => void;
    onNewTransaction: () => void;
    onEditTransaction: (transaction: FinanceTransaction) => void;
}

/**
 * L'accueil de la feature, et l'essentiel s'y lit : les chiffres de la période,
 * les comptes, ce qui arrive, ce qui vient de passer. « Voir tout » ouvre la
 * liste complète quand il en faut plus. Une seule lecture nourrit la page.
 */
export function Home(props: HomeProps) {
    const { base } = props;
    const [range, setRange] = useState<FinanceRange>('month');
    const cleared = useClearedToggle();

    const load = useCallback(async () => (await api.send('finance.overview', { range })).overview, [range]);
    const { data, error, loading } = useResource<FinanceOverview>('finance.overview', load, 'Chargement impossible.', [
        range
    ]);

    const hasAccounts = base.accounts.length > 0;
    const currency = base.config.currency;
    // Tous, archivés compris : le solde annoncé les compte aussi.
    const accountCount = base.accounts.length;

    const header = (
        <header className={styles.header}>
            <div>
                <h2 className={styles.heading}>Finances</h2>
                <p className={styles.subheading}>
                    {!hasAccounts
                        ? 'Aucun compte'
                        : data
                          ? `${formatMoney(data.netBalance, currency)} sur ${accountCount} compte${accountCount > 1 ? 's' : ''}`
                          : `${accountCount} compte${accountCount > 1 ? 's' : ''}`}
                </p>
            </div>
            <div className={styles.actions}>
                <FeatureSettingsButton scope={{ kind: 'feature', feature: 'finance' }} />
                {base.canWrite && hasAccounts && (
                    <Button icon='add' onClick={props.onNewTransaction}>
                        Opération
                    </Button>
                )}
            </div>
        </header>
    );

    if (!hasAccounts) {
        return (
            <div className={styles.home}>
                {header}
                <div className={styles.empty}>
                    <span className={`icon icon-finance ${styles.emptyIcon}`} aria-hidden='true' />
                    <p className={styles.emptyTitle}>Votre premier compte</p>
                    <p className={styles.emptyBody}>
                        Le compte de votre activité, avec le solde qu’indique votre banque aujourd’hui : c’est le point
                        de départ, et tous les soldes suivants s’en déduisent.
                    </p>
                    {base.canWrite && <Button onClick={props.onNewAccount}>Ajouter un compte</Button>}
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className={styles.home}>
                {header}
                {loading ? (
                    <p className={styles.placeholder}>Chargement…</p>
                ) : (
                    <ErrorNote note={{ message: error ?? 'Chargement impossible.', code: null }} />
                )}
            </div>
        );
    }

    const expenses = data.categories.filter((share) => share.flow === 'expense');
    const incomes = data.categories.filter((share) => share.flow === 'income');

    /** L'écart avec la période précédente, dit en une phrase courte. */
    const versus = (current: number, previous: number): string => {
        if (previous === 0) return current === 0 ? 'Rien sur la période' : 'Rien sur la période précédente';
        const change = Math.round(((current - previous) / previous) * 100);
        if (change === 0) return 'Comme la période précédente';
        return `${change > 0 ? '+' : '\u2212'}${Math.abs(change)} % sur la précédente`;
    };

    return (
        <div className={styles.home}>
            {header}

            <div className={styles.periodRow}>
                <SegmentedControl
                    aria-label='Période'
                    value={range}
                    options={RANGES.map((entry) => ({ value: entry.id, label: entry.label }))}
                    onChange={setRange}
                />
                <span className={styles.periodHint}>
                    Du {formatDate(data.from)} au {formatDate(data.to)}
                </span>
            </div>

            <dl className={styles.figures}>
                <div className={`${styles.figure} ${data.netBalance < 0 ? styles.figureBad : ''}`}>
                    <dt>Solde</dt>
                    <dd>{formatMoney(data.netBalance, currency)}</dd>
                    <p className={styles.figureNote}>
                        {data.savings !== 0
                            ? `Dont ${formatMoney(data.savings, currency)} d’épargne`
                            : data.projected !== data.netBalance
                              ? `${formatMoney(data.projected, currency)} avec ce qui est déjà daté plus tard`
                              : 'Sur tous vos comptes'}
                    </p>
                </div>
                <div className={styles.figure}>
                    <dt>Entrées</dt>
                    <dd>{formatMoney(data.income, currency)}</dd>
                    <p className={styles.figureNote}>{versus(data.income, data.previousIncome)}</p>
                </div>
                <div className={styles.figure}>
                    <dt>Sorties</dt>
                    <dd>{formatMoney(data.expense, currency)}</dd>
                    <p className={styles.figureNote}>{versus(data.expense, data.previousExpense)}</p>
                </div>
                <div className={`${styles.figure} ${data.net < 0 ? styles.figureBad : ''}`}>
                    <dt>Résultat</dt>
                    <dd>{formatSigned(data.net, currency)}</dd>
                    <p className={styles.figureNote}>Entrées moins sorties</p>
                </div>
                {data.vat && (
                    <div className={styles.figure}>
                        <dt>{data.vat.due >= 0 ? 'TVA à reverser' : 'TVA à récupérer'}</dt>
                        <dd>{formatMoney(Math.abs(data.vat.due), currency)}</dd>
                        <p className={styles.figureNote}>
                            {formatMoney(data.vat.collected, currency)} collectée,{' '}
                            {formatMoney(data.vat.deductible, currency)} déductible
                        </p>
                    </div>
                )}
            </dl>

            <Section
                title='Comptes'
                actions={
                    base.canWrite ? (
                        <Button variant='secondary' icon='add' onClick={props.onNewAccount}>
                            Compte
                        </Button>
                    ) : undefined
                }
            >
                <AccountGrid base={base} onOpen={props.onOpenAccount} />
            </Section>

            <Section
                title='À venir'
                hint='Les 45 prochains jours, retards compris.'
                actions={
                    <Button variant='ghost' onClick={props.onOpenRecurring}>
                        Échéances
                    </Button>
                }
            >
                {data.upcoming.length === 0 ? (
                    <p className={styles.placeholder}>
                        Rien d’attendu. Une échéance écrit toute seule un abonnement ou un loyer le jour venu, ou vous
                        le propose en un clic quand son montant varie.
                    </p>
                ) : (
                    <ul className={styles.rows}>
                        {data.upcoming.map((entry) => (
                            <li key={`${entry.recurringId}-${entry.date}`} className={styles.rowStatic}>
                                <span className={styles.rowText}>
                                    <span className={styles.rowLabel}>
                                        <span className={styles.rowLabelText}>{entry.label || 'Sans intitulé'}</span>
                                    </span>
                                    <span className={styles.rowMeta}>
                                        {accountName(base.accounts, entry.accountId)}
                                        {entry.automatic ? ' · écrite toute seule' : ' · à enregistrer'}
                                    </span>
                                </span>
                                <span className={styles.rowWhen} data-overdue={entry.overdue ? 'true' : undefined}>
                                    {formatRelativeDay(entry.date)}
                                    <span className={styles.rowDate}>{formatDate(entry.date)}</span>
                                </span>
                                <span className={styles.rowAmount} data-flow={flowOf(entry.kind)}>
                                    {signOf(entry.kind)}
                                    {formatMoney(entry.amount, currency)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section
                title='Dernières opérations'
                actions={
                    <Button variant='ghost' onClick={props.onOpenTransactions}>
                        Voir tout
                    </Button>
                }
            >
                <ErrorNote note={cleared.error} />
                {data.recent.length === 0 ? (
                    <p className={styles.placeholder}>Aucune opération pour l’instant.</p>
                ) : (
                    <ul className={styles.rows}>
                        {data.recent.map((row) => (
                            <li key={row.id}>
                                <TransactionRow
                                    base={base}
                                    row={row}
                                    busy={cleared.busy}
                                    onToggleCleared={cleared.toggle}
                                    onOpen={props.onEditTransaction}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title='Sur un an'>
                <FlowChart months={data.months} currency={currency} />
            </Section>

            <div className={styles.split}>
                <Section
                    title='Dépenses par catégorie'
                    actions={
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'finance' }}
                            initialSection='categories'
                            variant='ghost'
                            label='Catégories'
                        />
                    }
                >
                    <CategoryBars shares={expenses} categories={base.categories} currency={currency} />
                </Section>
                <Section title='Recettes par catégorie'>
                    <CategoryBars shares={incomes} categories={base.categories} currency={currency} limit={6} />
                </Section>
            </div>

            {!base.canWrite && (
                <p className={styles.placeholder}>
                    Votre rôle permet de lire les finances de cet espace, pas de les modifier.
                </p>
            )}
        </div>
    );
}

function Section({
    title,
    hint,
    actions,
    children
}: {
    title: string;
    hint?: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className={styles.section}>
            <header className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{title}</h3>
                {hint !== undefined && <span className={styles.sectionHint}>{hint}</span>}
                {actions !== undefined && <div className={styles.sectionActions}>{actions}</div>}
            </header>
            {children}
        </section>
    );
}

export default Home;
