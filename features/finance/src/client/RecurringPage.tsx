import { useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, ErrorNote, StatusBadge, StickyHeader, useResource, type ErrorNoteInput } from 'deveye-sdk-client';
import type { FinanceRecurring } from '../contracts/domain';

import PostDialog from './PostDialog';
import RecurringDialog from './RecurringDialog';
import { api, refreshFinance } from './api';
import { formatDate, formatMoney, formatRelativeDay, frequencyLabel, todayIso } from './format';
import { accountName, categoryOf, colorVar, errorNote, flowOf, signOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface RecurringPageProps {
    base: FinanceBase;
    onBack: () => void;
}

/**
 * Les échéances. Automatique : écrite seule à la première lecture après sa
 * date. Manuelle : proposée, et attend qu'on l'enregistre (montant variable).
 * Aucune tâche de fond : le retard est rattrapé au premier affichage.
 */
export function RecurringPage({ base, onBack }: RecurringPageProps) {
    const [editing, setEditing] = useState<{ recurring: FinanceRecurring | null } | null>(null);
    const [posting, setPosting] = useState<FinanceRecurring | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const load = useCallback(async () => (await api.send('finance.recurringList', {})).recurrings, []);
    const {
        data,
        error: loadError,
        loading
    } = useResource<FinanceRecurring[]>('finance.recurringList', load, 'Chargement impossible.');

    const skip = async (row: FinanceRecurring) => {
        setBusyId(row.id);
        setError(null);
        try {
            await api.send('finance.recurringSkip', { recurringId: row.id });
            refreshFinance();
        } catch (e) {
            setError(errorNote(e, 'Impossible de passer cette occurrence.'));
        } finally {
            setBusyId(null);
        }
    };

    const rows = data ?? [];
    const today = todayIso();
    const activeCount = rows.filter((row) => row.active).length;
    const dueCount = rows.filter((row) => row.active && !row.automatic && row.nextDate <= today).length;
    const note = error ?? (loadError ? { message: loadError, code: null } : null);

    return (
        <div className={styles.page}>
            <StickyHeader>
                <header className={styles.pageHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Accueil
                    </Button>
                    <div className={styles.ident}>
                        <h2 className={styles.pageTitle}>Échéances</h2>
                        {rows.length > 0 && (
                            <p className={styles.subheading}>
                                {activeCount} active{activeCount > 1 ? 's' : ''}
                                {dueCount > 0 && `, ${dueCount} à enregistrer`}
                            </p>
                        )}
                    </div>
                    {base.canWrite && base.accounts.length > 0 && (
                        <Button icon='add' onClick={() => setEditing({ recurring: null })}>
                            Échéance
                        </Button>
                    )}
                </header>
            </StickyHeader>

            <ErrorNote note={note} />

            {loading && !data ? (
                <p className={styles.placeholder}>Chargement…</p>
            ) : rows.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-clock ${styles.emptyIcon}`} aria-hidden='true' />
                    <p className={styles.emptyTitle}>Ce qui revient</p>
                    <p className={styles.emptyBody}>
                        Un serveur, un abonnement, une assurance, un loyer. DevEye l’écrit tout seul le jour venu, ou
                        vous le propose en un clic quand son montant change d’une fois sur l’autre.
                    </p>
                    {base.canWrite && base.accounts.length > 0 && (
                        <Button onClick={() => setEditing({ recurring: null })}>Ajouter une échéance</Button>
                    )}
                </div>
            ) : (
                <ul className={styles.rows}>
                    {rows.map((row, index) => {
                        const category = categoryOf(base.categories, row.categoryId);
                        const overdue = row.active && row.nextDate <= today;
                        return (
                            <motion.li
                                key={row.id}
                                className={styles.row}
                                data-inactive={row.active ? undefined : 'true'}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2, delay: Math.min(index, 6) * 0.03, ease: 'easeOut' }}
                            >
                                <button
                                    type='button'
                                    className={styles.rowBody}
                                    disabled={!base.canWrite}
                                    onClick={() => setEditing({ recurring: row })}
                                >
                                    <span
                                        className={`icon icon-${row.kind === 'transfer' ? 'move-to-right' : (category?.icon ?? 'clock')} ${styles.rowIcon}`}
                                        style={{ color: category ? colorVar(category.color) : undefined }}
                                        aria-hidden='true'
                                    />
                                    <span className={styles.rowText}>
                                        <span className={styles.rowLabel}>
                                            <span className={styles.rowLabelText}>{row.label || 'Sans intitulé'}</span>
                                            {!row.active ? (
                                                <StatusBadge tone='neutral' dot={false}>
                                                    Suspendue
                                                </StatusBadge>
                                            ) : row.automatic ? (
                                                <StatusBadge tone='accent' dot={false}>
                                                    Automatique
                                                </StatusBadge>
                                            ) : null}
                                        </span>
                                        <span className={styles.rowMeta}>
                                            {frequencyLabel(row.frequency, row.interval)} ·{' '}
                                            {accountName(base.accounts, row.accountId)}
                                            {row.endDate && ` · jusqu’au ${formatDate(row.endDate)}`}
                                        </span>
                                    </span>
                                    {row.active && (
                                        <span className={styles.rowWhen} data-overdue={overdue ? 'true' : undefined}>
                                            {formatRelativeDay(row.nextDate)}
                                            <span className={styles.rowDate}>{formatDate(row.nextDate)}</span>
                                        </span>
                                    )}
                                    <span className={styles.rowAmount} data-flow={flowOf(row.kind)}>
                                        {signOf(row.kind)}
                                        {formatMoney(row.amount, base.config.currency)}
                                    </span>
                                </button>

                                {base.canWrite && row.active && (
                                    <div className={styles.rowActions}>
                                        {!row.automatic && (
                                            <Button
                                                variant='secondary'
                                                icon='check-circle'
                                                disabled={busyId === row.id}
                                                title='Enregistrer l’occurrence attendue, montant corrigé au besoin'
                                                onClick={() => setPosting(row)}
                                            >
                                                Enregistrer
                                            </Button>
                                        )}
                                        <Button
                                            variant='ghost'
                                            icon='chevrons-right'
                                            disabled={busyId === row.id}
                                            title='Passer cette occurrence sans rien écrire'
                                            aria-label='Passer cette occurrence'
                                            onClick={() => void skip(row)}
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
                open={editing !== null}
                recurring={editing?.recurring ?? null}
                onClose={() => setEditing(null)}
                onSaved={() => setEditing(null)}
            />
            <PostDialog recurring={posting} onClose={() => setPosting(null)} />
        </div>
    );
}

export default RecurringPage;
