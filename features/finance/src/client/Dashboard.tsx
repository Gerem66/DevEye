import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, FeatureSettingsButton, useResource } from 'deveye-sdk-client';
import type { FinanceOverview, FinanceRange } from '../contracts/domain';

import CategoryBars from './Charts/CategoryBars';
import FlowChart from './Charts/FlowChart';
import { api } from './api';
import { RANGES, formatDate, formatMoney, formatRelativeDay, formatSigned } from './format';
import { accountName, categoryOf, colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface DashboardProps {
    base: FinanceBase;
    onOpenTab: (tab: string) => void;
    onNewTransaction: () => void;
}

/**
 * Le tableau de bord: la réponse à « où j'en suis », en un écran.
 *
 * Tout vient d'**une seule** commande (`finance.overview`). Six lectures
 * indépendantes laisseraient un écran où le solde vient d'avant une écriture et
 * la répartition d'après, et personne ne saurait laquelle des deux moitiés
 * croire.
 *
 * L'ordre de lecture descend du général au particulier: combien j'ai, comment ça
 * a bougé, où c'est parti, ce qui m'attend. Chaque bloc renvoie vers l'onglet qui
 * permet d'agir dessus, pour qu'on n'ait jamais à repasser par la barre.
 */
export function Dashboard({ base, onOpenTab, onNewTransaction }: DashboardProps) {
    const [range, setRange] = useState<FinanceRange>('month');

    const load = useCallback(async () => (await api.send('finance.overview', { range })).overview, [range]);
    const { data, error, loading } = useResource<FinanceOverview>('finance.overview', load, 'Chargement impossible.', [
        range
    ]);

    if (base.accounts.length === 0) {
        return (
            <div className={styles.empty}>
                <span className={`icon icon-finance ${styles.emptyIcon}`} />
                <h3 className={styles.emptyTitle}>Commencez par un compte</h3>
                <p className={styles.emptyText}>
                    Un compte courant, une caisse d’espèces, un livret. Indiquez son solde d’aujourd’hui: c’est le point
                    de départ du livre, et tout le reste s’en déduit.
                </p>
                {base.canWrite && (
                    <Button icon='plus' onClick={() => onOpenTab('accounts')}>
                        Ajouter un compte
                    </Button>
                )}
            </div>
        );
    }

    if (!data) {
        return <p className={loading ? styles.placeholder : styles.error}>{loading ? 'Chargement…' : error}</p>;
    }

    const expenses = data.categories.filter((share) => share.flow === 'expense');
    const incomes = data.categories.filter((share) => share.flow === 'income');
    const overBudget = data.budgets.filter((budget) => budget.remaining < 0).length;

    /** L'écart avec la même fenêtre précédente, en points de pourcentage. */
    const delta = (current: number, previous: number): string | null => {
        if (previous === 0) return null;
        const change = Math.round(((current - previous) / previous) * 100);
        if (change === 0) return null;
        return `${change > 0 ? '+' : ''}${change} %`;
    };

    return (
        <div className={styles.dashboard}>
            <div className={styles.rangeBar}>
                <div className={styles.segmented} role='tablist' aria-label='Période analysée'>
                    {RANGES.map((entry) => (
                        <button
                            key={entry.id}
                            type='button'
                            role='tab'
                            aria-selected={entry.id === range}
                            className={entry.id === range ? styles.segmentActive : styles.segment}
                            onClick={() => setRange(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
                <span className={styles.rangeHint}>
                    {formatDate(data.from)} au {formatDate(data.to)}
                </span>
            </div>

            {/* Les quatre nombres qu'on vient chercher, dans l'ordre où on les
                lit. Ils apparaissent en cascade au montage, brièvement: assez
                pour que l'œil suive la lecture, trop peu pour qu'on l'attende. */}
            <div className={styles.kpis}>
                {[
                    {
                        key: 'balance',
                        label: 'Solde total',
                        value: formatMoney(data.netBalance, data.currency),
                        tone: data.netBalance < 0 ? 'bad' : 'neutral',
                        hint:
                            data.savings > 0
                                ? `dont ${formatMoney(data.savings, data.currency)} d’épargne`
                                : data.projected !== data.netBalance
                                  ? `${formatMoney(data.projected, data.currency)} à venir`
                                  : 'sur tous vos comptes'
                    },
                    {
                        key: 'income',
                        label: 'Entrées',
                        value: formatMoney(data.income, data.currency),
                        tone: 'good',
                        hint: delta(data.income, data.previousIncome)
                            ? `${delta(data.income, data.previousIncome)} vs période précédente`
                            : 'sur la période'
                    },
                    {
                        key: 'expense',
                        label: 'Sorties',
                        value: formatMoney(data.expense, data.currency),
                        tone: 'bad',
                        hint: delta(data.expense, data.previousExpense)
                            ? `${delta(data.expense, data.previousExpense)} vs période précédente`
                            : 'sur la période'
                    },
                    {
                        key: 'net',
                        label: data.net >= 0 ? 'Épargné' : 'Puisé',
                        value: formatSigned(data.net, data.currency),
                        tone: data.net >= 0 ? 'good' : 'bad',
                        hint: 'entrées moins sorties'
                    }
                ].map((kpi, index) => (
                    <motion.div
                        key={kpi.key}
                        className={styles.kpi}
                        data-tone={kpi.tone}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, delay: index * 0.04, ease: 'easeOut' }}
                    >
                        <span className={styles.kpiLabel}>{kpi.label}</span>
                        <span className={styles.kpiValue}>{kpi.value}</span>
                        <span className={styles.kpiHint}>{kpi.hint}</span>
                    </motion.div>
                ))}
            </div>

            {data.vat && (
                <div className={styles.vatBand}>
                    <span className={styles.vatItem}>
                        <span className={styles.vatLabel}>TVA collectée</span>
                        <span className={styles.vatValue}>{formatMoney(data.vat.collected, data.currency)}</span>
                    </span>
                    <span className={styles.vatItem}>
                        <span className={styles.vatLabel}>TVA déductible</span>
                        <span className={styles.vatValue}>{formatMoney(data.vat.deductible, data.currency)}</span>
                    </span>
                    <span className={styles.vatItem} data-strong='true'>
                        <span className={styles.vatLabel}>{data.vat.due >= 0 ? 'À reverser' : 'À récupérer'}</span>
                        <span className={styles.vatValue}>{formatMoney(Math.abs(data.vat.due), data.currency)}</span>
                    </span>
                    <span className={styles.vatNote}>sur la période affichée, à partir des opérations saisies</span>
                </div>
            )}

            <section className={styles.card}>
                <header className={styles.cardHead}>
                    <h3 className={styles.cardTitle}>Douze derniers mois</h3>
                </header>
                <FlowChart months={data.months} currency={data.currency} />
            </section>

            <div className={styles.split}>
                <section className={styles.card}>
                    <header className={styles.cardHead}>
                        <h3 className={styles.cardTitle}>Où part l’argent</h3>
                        {/* La grille de lecture se règle dans les réglages de la
                            feature (panneau Catégories) : le bouton commun y mène. */}
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'finance' }}
                            initialSection='categories'
                            variant='ghost'
                            label='Catégories'
                        />
                    </header>
                    <CategoryBars shares={expenses} categories={base.categories} currency={data.currency} />
                </section>

                <section className={styles.card}>
                    <header className={styles.cardHead}>
                        <h3 className={styles.cardTitle}>D’où il vient</h3>
                    </header>
                    <CategoryBars shares={incomes} categories={base.categories} currency={data.currency} limit={6} />
                </section>
            </div>

            <div className={styles.split}>
                <section className={styles.card}>
                    <header className={styles.cardHead}>
                        <h3 className={styles.cardTitle}>Budgets</h3>
                        <button type='button' className={styles.cardLink} onClick={() => onOpenTab('budgets')}>
                            {overBudget > 0 ? `${overBudget} dépassé${overBudget > 1 ? 's' : ''}` : 'Gérer'}
                        </button>
                    </header>
                    {data.budgets.length === 0 ? (
                        <p className={styles.placeholder}>
                            Aucune enveloppe. Un budget fixe un plafond par catégorie et se recalcule à chaque période.
                        </p>
                    ) : (
                        <ul className={styles.gauges}>
                            {data.budgets.slice(0, 5).map((budget) => {
                                const category = categoryOf(base.categories, budget.categoryId);
                                const ratio = budget.amount === 0 ? 0 : budget.spent / budget.amount;
                                return (
                                    <li key={budget.id} className={styles.gauge}>
                                        <span className={styles.gaugeHead}>
                                            <span
                                                className={`icon icon-${category?.icon ?? 'other'} ${styles.shareIcon}`}
                                                style={{ color: category ? colorVar(category.color) : undefined }}
                                            />
                                            <span className={styles.shareName}>{category?.name ?? 'Catégorie'}</span>
                                            <span
                                                className={styles.gaugeAmount}
                                                data-over={budget.remaining < 0 ? 'true' : undefined}
                                            >
                                                {formatMoney(budget.spent, data.currency)} /{' '}
                                                {formatMoney(budget.amount, data.currency)}
                                            </span>
                                        </span>
                                        <span className={styles.shareTrack}>
                                            <span
                                                className={styles.gaugeFill}
                                                data-over={ratio > 1 ? 'true' : undefined}
                                                data-near={ratio > 0.85 && ratio <= 1 ? 'true' : undefined}
                                                style={{ width: `${Math.min(100, ratio * 100)}%` }}
                                            />
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                <section className={styles.card}>
                    <header className={styles.cardHead}>
                        <h3 className={styles.cardTitle}>À venir</h3>
                        <button type='button' className={styles.cardLink} onClick={() => onOpenTab('recurring')}>
                            Échéances
                        </button>
                    </header>
                    {data.upcoming.length === 0 ? (
                        <p className={styles.placeholder}>
                            Rien d’attendu dans les prochaines semaines. Une échéance écrit un loyer ou un salaire toute
                            seule, ou vous le propose en un clic.
                        </p>
                    ) : (
                        <ul className={styles.upcoming}>
                            {data.upcoming.map((entry) => (
                                <li key={`${entry.recurringId}-${entry.date}`} className={styles.upcomingRow}>
                                    <span
                                        className={styles.upcomingWhen}
                                        data-overdue={entry.overdue ? 'true' : undefined}
                                    >
                                        {formatRelativeDay(entry.date)}
                                    </span>
                                    <span className={styles.upcomingLabel}>
                                        {entry.label || 'Sans intitulé'}
                                        <span className={styles.upcomingAccount}>
                                            {accountName(base.accounts, entry.accountId)}
                                            {entry.automatic ? ' · automatique' : ''}
                                        </span>
                                    </span>
                                    <span
                                        className={styles.upcomingAmount}
                                        data-flow={
                                            entry.kind === 'income'
                                                ? 'in'
                                                : entry.kind === 'expense'
                                                  ? 'out'
                                                  : undefined
                                        }
                                    >
                                        {entry.kind === 'income' ? '+' : entry.kind === 'expense' ? '−' : ''}
                                        {formatMoney(entry.amount, data.currency)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>

            {base.canWrite && (
                <div className={styles.dashboardFoot}>
                    <Button variant='secondary' icon='plus' onClick={onNewTransaction}>
                        Saisir une opération
                    </Button>
                </div>
            )}
        </div>
    );
}

export default Dashboard;
