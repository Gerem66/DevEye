import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
    Button,
    Checkbox,
    ErrorNote,
    FeatureSettingsButton,
    SegmentedControl,
    StatusBadge,
    useResource,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { StatementLine } from '../contracts/statement';

import ResolveDialog, { titleOf } from './ResolveDialog';
import { api, refreshFinance } from './api';
import { formatDate, formatMoney } from './format';
import { accountName, errorNote, signOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface ReviewPageProps {
    base: FinanceBase;
    onBack: () => void;
    onImport: () => void;
}

type Status = 'pending' | 'all';

const STATUSES: { value: Status; label: string }[] = [
    { value: 'pending', label: 'À rapprocher' },
    { value: 'all', label: 'Toutes' }
];

/**
 * Les lignes de relevé que rien n'a encore rangées. Chacune s'ouvre sur ce que
 * DevEye y reconnaît ; plusieurs du même sens se rangent d'un coup. En tête, le
 * dernier solde annoncé par chaque banque face au pointé du livre.
 */
export function ReviewPage({ base, onBack, onImport }: ReviewPageProps) {
    const [status, setStatus] = useState<Status>('pending');
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [resolving, setResolving] = useState<StatementLine[] | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const load = useCallback(async () => api.send('finance.statementList', { status }), [status]);
    const {
        data,
        error: loadError,
        loading
    } = useResource('finance.statementList', load, 'Chargement impossible.', [status]);

    // Une ligne rangée ailleurs (par un autre membre, par une règle) sort de la sélection.
    useEffect(() => {
        if (!data) return;
        const open = new Set(data.lines.filter((line) => line.status === 'pending').map((line) => line.id));
        setSelected((current) => {
            const kept = [...current].filter((id) => open.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
    }, [data]);

    const lines = data?.lines ?? [];
    const pendingCount = data?.pendingCount ?? 0;
    const currency = base.config.currency;
    const manyAccounts = new Set(lines.map((line) => line.accountId)).size > 1;
    const chosen = lines.filter((line) => selected.has(line.id));

    const toggle = (id: number, on: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });

    const setIgnored = async (ids: number[], ignored: boolean) => {
        setBusyId(ids.length === 1 ? ids[0] : -1);
        setError(null);
        try {
            await api.send('finance.statementResolve', {
                lineIds: ids,
                action: { kind: ignored ? 'ignore' : 'restore' }
            });
            setSelected(new Set());
            refreshFinance();
        } catch (e) {
            setError(
                errorNote(e, ignored ? 'Impossible d’écarter ces lignes.' : 'Impossible de rétablir cette ligne.')
            );
        } finally {
            setBusyId(null);
        }
    };

    const note = error ?? (loadError ? { message: loadError, code: null } : null);

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <div className={styles.detailHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Accueil
                    </Button>
                    <div className={styles.ident}>
                        <h2 className={styles.heading}>Relevés</h2>
                        {data && (
                            <p className={styles.subheading}>
                                {pendingCount === 0
                                    ? 'Tout est rapproché'
                                    : `${pendingCount} ligne${pendingCount > 1 ? 's' : ''} à rapprocher`}
                            </p>
                        )}
                    </div>
                </div>
                <div className={styles.actions}>
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'finance' }}
                        initialSection='rules'
                        variant='ghost'
                        label='Règles'
                    />
                    {base.canWrite && (
                        <Button icon='file' onClick={onImport}>
                            Importer
                        </Button>
                    )}
                </div>
            </header>

            <ErrorNote note={note} />

            {data && data.banks.length > 0 && (
                <dl className={styles.figures}>
                    {data.banks.map((bank) => {
                        const gap = bank.bank - bank.book;
                        return (
                            <div
                                key={bank.accountId}
                                className={`${styles.figure} ${gap !== 0 ? styles.figureBad : ''}`}
                            >
                                <dt>{accountName(base.accounts, bank.accountId)}</dt>
                                <dd>{formatMoney(bank.bank, currency)}</dd>
                                <p className={styles.figureNote}>
                                    {gap === 0
                                        ? `Selon la banque au ${formatDate(bank.date)}, le livre pointé tombe juste`
                                        : `Selon la banque au ${formatDate(bank.date)}, ${formatMoney(Math.abs(gap), currency)} ${gap > 0 ? 'de plus' : 'de moins'} que le livre pointé`}
                                </p>
                            </div>
                        );
                    })}
                </dl>
            )}

            {loading && !data ? (
                <p className={styles.placeholder}>Chargement…</p>
            ) : lines.length === 0 && status === 'pending' ? (
                <div className={styles.empty}>
                    <span className={`icon icon-check-circle ${styles.emptyIcon}`} aria-hidden='true' />
                    <p className={styles.emptyTitle}>Rien à rapprocher</p>
                    <p className={styles.emptyBody}>
                        Importez le relevé de votre banque, en CSV ou en OFX : ses lignes retrouvent les opérations déjà
                        au livre, vos règles rangent les habituelles, et il ne reste ici que ce qui demande un choix.
                    </p>
                    <div className={styles.actions}>
                        {base.canWrite && <Button onClick={onImport}>Importer un relevé</Button>}
                        <Button variant='ghost' onClick={() => setStatus('all')}>
                            Voir les lignes rangées
                        </Button>
                    </div>
                </div>
            ) : (
                <section className={styles.section}>
                    <header className={styles.sectionHead}>
                        <h3 className={styles.sectionTitle}>Lignes</h3>
                        <div className={styles.sectionActions}>
                            {chosen.length > 0 ? (
                                <>
                                    <Button
                                        variant='ghost'
                                        disabled={busyId !== null}
                                        onClick={() =>
                                            void setIgnored(
                                                chosen.map((line) => line.id),
                                                true
                                            )
                                        }
                                    >
                                        Écarter {chosen.length}
                                    </Button>
                                    <Button variant='secondary' onClick={() => setResolving(chosen)}>
                                        Ranger {chosen.length}
                                    </Button>
                                </>
                            ) : (
                                <SegmentedControl
                                    aria-label='Lignes montrées'
                                    value={status}
                                    options={STATUSES}
                                    onChange={(value) => {
                                        setSelected(new Set());
                                        setStatus(value);
                                    }}
                                />
                            )}
                        </div>
                    </header>

                    {lines.length === 0 && <p className={styles.placeholder}>Aucun relevé importé pour l’instant.</p>}
                    <ul className={styles.rows} hidden={lines.length === 0}>
                        {lines.map((line, index) => {
                            const open = line.status === 'pending';
                            const hint =
                                open && line.proposals.length > 0 ? `Peut-être ${titleOf(line.proposals[0])}` : '';
                            const meta = [
                                manyAccounts ? accountName(base.accounts, line.accountId) : '',
                                line.memo,
                                hint
                            ]
                                .filter(Boolean)
                                .join(' · ');
                            return (
                                <motion.li
                                    key={line.id}
                                    className={styles.row}
                                    data-inactive={line.status === 'ignored' ? 'true' : undefined}
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.2, delay: Math.min(index, 6) * 0.03, ease: 'easeOut' }}
                                >
                                    {base.canWrite && open && (
                                        <Checkbox
                                            className={styles.rowCheck}
                                            aria-label={`Choisir « ${line.label || 'Sans libellé'} »`}
                                            checked={selected.has(line.id)}
                                            onChange={(on) => toggle(line.id, on)}
                                        />
                                    )}
                                    <button
                                        type='button'
                                        className={styles.rowBody}
                                        disabled={!base.canWrite || !open}
                                        onClick={() => setResolving([line])}
                                    >
                                        <span className={styles.rowText}>
                                            <span className={styles.rowLabel}>
                                                <span className={styles.rowLabelText}>
                                                    {line.label || 'Sans libellé'}
                                                </span>
                                                {line.status === 'matched' && (
                                                    <StatusBadge tone='success' dot={false}>
                                                        Rapprochée
                                                    </StatusBadge>
                                                )}
                                                {line.status === 'ignored' && (
                                                    <StatusBadge tone='neutral' dot={false}>
                                                        Écartée
                                                    </StatusBadge>
                                                )}
                                            </span>
                                            {meta && <span className={styles.rowMeta}>{meta}</span>}
                                        </span>
                                        <span className={styles.rowWhen}>{formatDate(line.date)}</span>
                                        <span
                                            className={styles.rowAmount}
                                            data-flow={line.direction === 'in' ? 'in' : undefined}
                                        >
                                            {signOf(line.direction === 'in' ? 'income' : 'expense')}
                                            {formatMoney(line.amount, currency)}
                                        </span>
                                    </button>
                                    {base.canWrite && line.status !== 'matched' && (
                                        <div className={styles.rowActions}>
                                            <Button
                                                variant='ghost'
                                                icon={open ? 'eye-close' : 'eye-open'}
                                                disabled={busyId !== null}
                                                title={
                                                    open
                                                        ? 'Écarter : un mouvement qui n’a rien à faire au livre'
                                                        : 'Rétablir : la remettre à rapprocher'
                                                }
                                                aria-label={open ? 'Écarter cette ligne' : 'Rétablir cette ligne'}
                                                onClick={() => void setIgnored([line.id], open)}
                                            />
                                        </div>
                                    )}
                                </motion.li>
                            );
                        })}
                    </ul>
                </section>
            )}

            <ResolveDialog
                base={base}
                lines={resolving}
                onClose={() => {
                    setResolving(null);
                    setSelected(new Set());
                }}
            />
        </div>
    );
}

export default ReviewPage;
