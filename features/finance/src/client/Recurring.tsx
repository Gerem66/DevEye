import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, humanizeError, useResource } from 'deveye-sdk-client';
import type { FinanceRecurring } from '../contracts/domain';

import RecurringDialog from './RecurringDialog';
import { api, refreshFinance } from './api';
import { formatDate, formatMoney, formatRelativeDay, frequencyLabel, todayIso } from './format';
import { accountName, categoryOf, colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface RecurringProps {
    base: FinanceBase;
}

/**
 * Les échéances: loyer, salaire, abonnements, remboursements de prêt.
 *
 * ## Automatique ou proposée
 *
 * Une échéance **automatique** s'écrit toute seule à la première lecture qui suit
 * sa date, parce qu'un salaire tombe qu'on regarde ou non. Une échéance
 * **manuelle** attend un clic, ce qui est exactement ce qu'on veut d'une facture
 * dont le montant varie: la voir apparaître à un montant faux serait pire que de
 * ne pas la voir.
 *
 * Il n'y a donc aucune tâche de fond derrière cet écran, et rien à réparer si le
 * serveur était arrêté: le retard est rattrapé au premier affichage.
 */
export function Recurring({ base }: RecurringProps) {
    const [dialog, setDialog] = useState<{ recurring: FinanceRecurring | null } | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => (await api.send('finance.recurringList', {})).recurrings, []);
    const {
        data,
        error: loadError,
        loading
    } = useResource<FinanceRecurring[]>('finance.recurringList', load, 'Chargement impossible.');

    const run = async (id: number, action: () => Promise<unknown>, fallback: string) => {
        setBusyId(id);
        setError(null);
        try {
            await action();
            refreshFinance();
        } catch (e) {
            setError(humanizeError(e, fallback));
        } finally {
            setBusyId(null);
        }
    };

    if (loading && !data) return <p className={styles.placeholder}>Chargement…</p>;

    const rows = data ?? [];
    const today = todayIso();
    const due = rows.filter((row) => row.active && row.nextDate <= today);

    return (
        <div className={styles.recurring}>
            <div className={styles.accountsHead}>
                <div>
                    <span className={styles.accountsTotalLabel}>Échéances</span>
                    <span className={styles.budgetsCount}>
                        {rows.filter((row) => row.active).length} active
                        {rows.filter((row) => row.active).length > 1 ? 's' : ''}
                        {due.length > 0 && ` · ${due.length} à enregistrer`}
                    </span>
                </div>
                {base.canWrite && base.accounts.length > 0 && (
                    <Button icon='plus' onClick={() => setDialog({ recurring: null })}>
                        Ajouter une échéance
                    </Button>
                )}
            </div>

            {(error ?? loadError) && <p className={styles.error}>{error ?? loadError}</p>}

            {rows.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-clock ${styles.emptyIcon}`} />
                    <h3 className={styles.emptyTitle}>Aucune échéance</h3>
                    <p className={styles.emptyText}>
                        Déclarez ce qui revient: un loyer, un salaire, un abonnement. DevEye l’écrit tout seul le jour
                        venu, ou vous le propose en un clic si le montant change d’une fois sur l’autre.
                    </p>
                </div>
            ) : (
                <ul className={styles.recurringList}>
                    {rows.map((row, index) => {
                        const category = categoryOf(base.categories, row.categoryId);
                        const overdue = row.active && row.nextDate <= today;
                        return (
                            <motion.li
                                key={row.id}
                                className={styles.recurringRow}
                                data-inactive={row.active ? undefined : 'true'}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2, delay: Math.min(index, 6) * 0.03, ease: 'easeOut' }}
                            >
                                <button
                                    type='button'
                                    className={styles.recurringBody}
                                    disabled={!base.canWrite}
                                    onClick={() => base.canWrite && setDialog({ recurring: row })}
                                >
                                    <span
                                        className={`icon icon-${row.kind === 'transfer' ? 'move-to-right' : (category?.icon ?? 'clock')} ${styles.rowIcon}`}
                                        style={{ color: category ? colorVar(category.color) : undefined }}
                                    />
                                    <span className={styles.rowText}>
                                        <span className={styles.rowLabel}>
                                            {row.label || 'Sans intitulé'}
                                            {row.automatic && <span className={styles.autoBadge}>auto</span>}
                                            {!row.active && <span className={styles.pausedBadge}>suspendue</span>}
                                        </span>
                                        <span className={styles.rowMeta}>
                                            {frequencyLabel(row.frequency, row.interval)} ·{' '}
                                            {accountName(base.accounts, row.accountId)}
                                            {row.endDate && ` · jusqu’au ${formatDate(row.endDate)}`}
                                        </span>
                                    </span>
                                    <span className={styles.recurringWhen} data-overdue={overdue ? 'true' : undefined}>
                                        {row.active ? formatRelativeDay(row.nextDate) : '—'}
                                        <span className={styles.recurringDate}>
                                            {row.active ? formatDate(row.nextDate) : 'en pause'}
                                        </span>
                                    </span>
                                    <span
                                        className={styles.rowAmount}
                                        data-flow={
                                            row.kind === 'income' ? 'in' : row.kind === 'expense' ? 'out' : undefined
                                        }
                                    >
                                        {row.kind === 'income' ? '+' : row.kind === 'expense' ? '−' : ''}
                                        {formatMoney(row.amount, base.config.currency)}
                                    </span>
                                </button>

                                {base.canWrite && row.active && (
                                    <div className={styles.recurringActions}>
                                        <Button
                                            variant='secondary'
                                            icon='check-circle'
                                            disabled={busyId === row.id}
                                            title='Enregistrer l’occurrence attendue'
                                            onClick={() =>
                                                void run(
                                                    row.id,
                                                    () => api.send('finance.recurringPost', { recurringId: row.id }),
                                                    'Enregistrement impossible.'
                                                )
                                            }
                                        >
                                            Enregistrer
                                        </Button>
                                        <Button
                                            variant='ghost'
                                            icon='chevrons-right'
                                            disabled={busyId === row.id}
                                            title='Passer cette occurrence sans rien écrire'
                                            aria-label='Passer cette occurrence'
                                            onClick={() =>
                                                void run(
                                                    row.id,
                                                    () => api.send('finance.recurringSkip', { recurringId: row.id }),
                                                    'Impossible de passer cette occurrence.'
                                                )
                                            }
                                        />
                                    </div>
                                )}
                            </motion.li>
                        );
                    })}
                </ul>
            )}

            <RecurringDialog
                base={base}
                open={dialog !== null}
                recurring={dialog?.recurring ?? null}
                onClose={() => setDialog(null)}
                onSaved={() => setDialog(null)}
            />
        </div>
    );
}

export default Recurring;
