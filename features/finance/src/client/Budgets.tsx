import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, FeatureSettingsButton, useResource } from 'deveye-sdk-client';
import type { FinanceBudget } from '../contracts/domain';

import BudgetDialog from './BudgetDialog';
import { api } from './api';
import { budgetPeriodShort, formatDate, formatMoney } from './format';
import { categoryOf, colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface BudgetsProps {
    base: FinanceBase;
}

/**
 * Les enveloppes. Consommé et restant sont recalculés à chaque lecture : un
 * budget est une règle, pas un compteur. Une seule par catégorie.
 */
export function Budgets({ base }: BudgetsProps) {
    const [dialog, setDialog] = useState<{ budget: FinanceBudget | null } | null>(null);

    const load = useCallback(async () => (await api.send('finance.budgetList', {})).budgets, []);
    const { data, error, loading } = useResource<FinanceBudget[]>('finance.budgetList', load, 'Chargement impossible.');

    const spendable = base.categories.filter((category) => category.flow === 'expense');
    const covered = new Set((data ?? []).map((budget) => budget.categoryId));
    const available = spendable.filter((category) => !covered.has(category.id));

    if (loading && !data) return <p className={styles.placeholder}>Chargement…</p>;

    return (
        <div className={styles.budgets}>
            <div className={styles.accountsHead}>
                <div>
                    <span className={styles.accountsTotalLabel}>Enveloppes</span>
                    <span className={styles.budgetsCount}>
                        {(data ?? []).length} posée{(data ?? []).length > 1 ? 's' : ''}
                        {(data ?? []).filter((budget) => budget.remaining < 0).length > 0 &&
                            ` · ${(data ?? []).filter((budget) => budget.remaining < 0).length} dépassée(s)`}
                    </span>
                </div>
                {base.canWrite && available.length > 0 && (
                    <Button icon='plus' onClick={() => setDialog({ budget: null })}>
                        Poser un budget
                    </Button>
                )}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {(data ?? []).length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-square-check ${styles.emptyIcon}`} />
                    <h3 className={styles.emptyTitle}>Aucune enveloppe</h3>
                    <p className={styles.emptyText}>
                        Un budget fixe un plafond sur une catégorie de dépenses et se remet à zéro à chaque période. Il
                        ne bloque rien: il montre où vous en êtes.
                    </p>
                    {base.canWrite &&
                        (spendable.length === 0 ? (
                            // Sans catégorie de dépenses, rien à budgéter : le bouton mène aux réglages.
                            <FeatureSettingsButton
                                scope={{ kind: 'feature', feature: 'finance' }}
                                initialSection='categories'
                                label='Créer des catégories d’abord'
                            />
                        ) : (
                            <Button icon='plus' onClick={() => setDialog({ budget: null })}>
                                Poser un budget
                            </Button>
                        ))}
                </div>
            ) : (
                <ul className={styles.budgetList}>
                    {(data ?? []).map((budget, index) => {
                        const category = categoryOf(base.categories, budget.categoryId);
                        const ratio = budget.amount === 0 ? 0 : budget.spent / budget.amount;
                        const over = budget.remaining < 0;
                        return (
                            <motion.li
                                key={budget.id}
                                className={styles.budgetRow}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2, delay: Math.min(index, 6) * 0.03, ease: 'easeOut' }}
                            >
                                <button
                                    type='button'
                                    className={styles.budgetBody}
                                    disabled={!base.canWrite}
                                    onClick={() => base.canWrite && setDialog({ budget })}
                                >
                                    <span className={styles.budgetHead}>
                                        <span
                                            className={`icon icon-${category?.icon ?? 'other'} ${styles.shareIcon}`}
                                            style={{ color: category ? colorVar(category.color) : undefined }}
                                        />
                                        <span className={styles.shareName}>{category?.name ?? 'Catégorie'}</span>
                                        <span className={styles.budgetPeriod}>
                                            par {budgetPeriodShort(budget.period)}
                                        </span>
                                        <span className={styles.budgetAmount} data-over={over ? 'true' : undefined}>
                                            {formatMoney(budget.spent, base.config.currency)} /{' '}
                                            {formatMoney(budget.amount, base.config.currency)}
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

                                    <span className={styles.budgetFoot}>
                                        <span data-over={over ? 'true' : undefined}>
                                            {over
                                                ? `Dépassé de ${formatMoney(-budget.remaining, base.config.currency)}`
                                                : `Reste ${formatMoney(budget.remaining, base.config.currency)}`}
                                        </span>
                                        <span className={styles.budgetWindow}>
                                            période en cours depuis le {formatDate(budget.periodStart)}
                                        </span>
                                    </span>
                                </button>
                            </motion.li>
                        );
                    })}
                </ul>
            )}

            <BudgetDialog
                base={base}
                open={dialog !== null}
                budget={dialog?.budget ?? null}
                available={available}
                onClose={() => setDialog(null)}
                onSaved={() => setDialog(null)}
            />
        </div>
    );
}

export default Budgets;
