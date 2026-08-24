import { useCallback, useMemo, useState } from 'react';
import type { FinanceTransaction, FinanceTransactionKind } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import { humanizeError, refreshFinance, useFinanceResource } from './api';
import { TRANSACTION_KINDS, formatDayHeading, formatMoney, formatSigned, shiftDays, todayIso } from './format';
import { accountName, categoryOf, colorVar } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface TransactionsProps {
    base: FinanceBase;
    onEdit: (transaction: FinanceTransaction) => void;
}

/** Les fenêtres proposées, en jours de recul. `0` = tout l'historique. */
const WINDOWS: { id: string; label: string; days: number }[] = [
    { id: '30', label: '30 jours', days: 30 },
    { id: '90', label: '3 mois', days: 90 },
    { id: '365', label: '12 mois', days: 365 },
    { id: 'all', label: 'Tout', days: 0 }
];

/** Combien de lignes par page. Le serveur plafonne à 500. */
const PAGE = 100;

interface Result {
    transactions: FinanceTransaction[];
    total: number;
    totals: { income: number; expense: number; net: number };
}

/**
 * Le journal: la liste des opérations, filtrée, et la saisie qui va avec.
 *
 * ## Ce qui est filtré où, et pourquoi
 *
 * Compte, catégorie, nature, période et pointage sont filtrés **en SQL**, sur des
 * colonnes en clair. La **recherche textuelle**, elle, se fait dans le
 * navigateur, sur ce qui a été chargé: l'intitulé et le tiers sont chiffrés, donc
 * aucun `LIKE` ne les atteint côté serveur. C'est honnête tant que la fenêtre est
 * bornée par une période, ce que le sélecteur impose par défaut, et l'écran le
 * dit quand la recherche ne porte que sur une page.
 *
 * ## Les totaux ne sont pas ceux de la page
 *
 * Ils viennent du serveur et couvrent **tout** le filtre. Un total qui ne
 * compterait que les cent lignes affichées sur trois cents induirait en erreur
 * précisément là où on vient chercher un chiffre juste.
 */
export function Transactions({ base, onEdit }: TransactionsProps) {
    const [windowId, setWindowId] = useState('90');
    const [accountId, setAccountId] = useState<number | null>(null);
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const [kind, setKind] = useState<FinanceTransactionKind | null>(null);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const days = WINDOWS.find((entry) => entry.id === windowId)?.days ?? 0;
    const from = days === 0 ? undefined : shiftDays(todayIso(), -days);

    const load = useCallback(async () => {
        const res = await ws.send('finance.transactionList', {
            ...(accountId !== null ? { accountId } : {}),
            ...(categoryId !== null ? { categoryId } : {}),
            ...(kind !== null ? { kind } : {}),
            ...(from ? { from } : {}),
            limit: PAGE,
            offset: page * PAGE
        });
        return res as Result;
    }, [accountId, categoryId, kind, from, page]);

    const { data, error, loading } = useFinanceResource<Result>(
        'finance.transactionList',
        load,
        'Chargement impossible.',
        [accountId, categoryId, kind, from, page]
    );

    /** Le filtre textuel, appliqué à ce qui est chargé (voir l'en-tête). */
    const rows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        if (!data) return [];
        if (needle === '') return data.transactions;
        return data.transactions.filter((row) =>
            `${row.label} ${row.counterparty} ${row.note}`.toLowerCase().includes(needle)
        );
    }, [data, search]);

    /** Les lignes groupées par jour, dans l'ordre où le serveur les a rendues. */
    const groups = useMemo(() => {
        const byDay = new Map<string, FinanceTransaction[]>();
        for (const row of rows) {
            const bucket = byDay.get(row.date);
            if (bucket) bucket.push(row);
            else byDay.set(row.date, [row]);
        }
        return [...byDay.entries()];
    }, [rows]);

    const toggleCleared = async (row: FinanceTransaction) => {
        setBusy(true);
        try {
            await ws.send('finance.transactionSetCleared', {
                transactionIds: [row.id],
                cleared: !row.cleared
            });
            refreshFinance();
            setActionError(null);
        } catch (e) {
            setActionError(humanizeError(e, 'Pointage impossible.'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * L'export CSV, fabriqué dans le navigateur.
     *
     * Rien à demander au serveur: les lignes affichées sont déjà déchiffrées ici,
     * et lui demander de les rechiffrer en fichier ne ferait qu'ajouter une
     * commande et un chemin où le contenu en clair transiterait à nouveau.
     * L'export porte donc exactement ce qui est à l'écran, filtre compris.
     */
    const exportCsv = () => {
        const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
        const header = ['Date', 'Nature', 'Intitulé', 'Tiers', 'Compte', 'Catégorie', 'Montant', 'TVA', 'Pointée'];
        const lines = rows.map((row) =>
            [
                row.date,
                row.kind === 'income' ? 'Recette' : row.kind === 'expense' ? 'Dépense' : 'Virement',
                escape(row.label),
                escape(row.counterparty),
                escape(accountName(base.accounts, row.accountId)),
                escape(categoryOf(base.categories, row.categoryId)?.name ?? ''),
                // Le point décimal et non la virgule: c'est ce qu'attend un
                // tableur configuré en anglais, et c'est le seul format qu'aucun
                // n'interprète comme un séparateur de colonnes.
                (row.amount / 100).toFixed(2),
                row.vatAmount === null ? '' : (row.vatAmount / 100).toFixed(2),
                row.cleared ? 'oui' : 'non'
            ].join(';')
        );
        // La marque d'ordre des octets en tête: sans elle, Excel lit un fichier
        // UTF-8 comme du latin-1 et transforme chaque accent en deux caractères.
        const csv = `\uFEFF${[header.join(';'), ...lines].join('\r\n')}`;
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `operations-${todayIso()}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

    return (
        <div className={styles.journal}>
            <div className={styles.filters}>
                <div className={styles.segmented} role='tablist' aria-label='Période'>
                    {WINDOWS.map((entry) => (
                        <button
                            key={entry.id}
                            type='button'
                            role='tab'
                            aria-selected={entry.id === windowId}
                            className={entry.id === windowId ? styles.segmentActive : styles.segment}
                            onClick={() => {
                                setWindowId(entry.id);
                                setPage(0);
                            }}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>

                <SelectInput
                    value={accountId ?? ''}
                    aria-label='Compte'
                    onChange={(e) => {
                        setAccountId(e.target.value === '' ? null : Number(e.target.value));
                        setPage(0);
                    }}
                >
                    <option value=''>Tous les comptes</option>
                    {base.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                            {account.name}
                            {account.archived ? ' (archivé)' : ''}
                        </option>
                    ))}
                </SelectInput>

                <SelectInput
                    value={categoryId ?? ''}
                    aria-label='Catégorie'
                    onChange={(e) => {
                        setCategoryId(e.target.value === '' ? null : Number(e.target.value));
                        setPage(0);
                    }}
                >
                    <option value=''>Toutes les catégories</option>
                    {base.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                            {category.name}
                        </option>
                    ))}
                </SelectInput>

                <SelectInput
                    value={kind ?? ''}
                    aria-label='Nature'
                    onChange={(e) => {
                        setKind(e.target.value === '' ? null : (e.target.value as FinanceTransactionKind));
                        setPage(0);
                    }}
                >
                    <option value=''>Toutes natures</option>
                    {TRANSACTION_KINDS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.label}
                        </option>
                    ))}
                </SelectInput>

                <TextInput
                    type='search'
                    placeholder='Rechercher…'
                    aria-label='Rechercher dans les opérations chargées'
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />

                <Button variant='ghost' icon='download' onClick={exportCsv} disabled={rows.length === 0}>
                    CSV
                </Button>
            </div>

            {data && (
                <div className={styles.totals}>
                    <span className={styles.totalIn}>+ {formatMoney(data.totals.income, base.config.currency)}</span>
                    <span className={styles.totalOut}>− {formatMoney(data.totals.expense, base.config.currency)}</span>
                    <span className={styles.totalNet} data-negative={data.totals.net < 0 ? 'true' : undefined}>
                        {formatSigned(data.totals.net, base.config.currency)}
                    </span>
                    <span className={styles.totalsNote}>
                        {data.total} opération{data.total > 1 ? 's' : ''} dans ce filtre
                        {search.trim() !== '' && ` · recherche sur les ${data.transactions.length} lignes chargées`}
                    </span>
                </div>
            )}

            {(error ?? actionError) && <p className={styles.error}>{actionError ?? error}</p>}

            {loading && !data ? (
                <p className={styles.placeholder}>Chargement…</p>
            ) : groups.length === 0 ? (
                <p className={styles.placeholder}>
                    {search.trim() === ''
                        ? 'Aucune opération sur cette période.'
                        : 'Rien ne correspond à cette recherche dans les lignes chargées.'}
                </p>
            ) : (
                <div className={styles.days}>
                    {groups.map(([day, entries]) => (
                        <section key={day} className={styles.day}>
                            <h4 className={styles.dayHead}>
                                <span>{formatDayHeading(day)}</span>
                                <span className={styles.dayTotal}>
                                    {formatSigned(
                                        entries.reduce(
                                            (sum, row) =>
                                                sum +
                                                (row.kind === 'income'
                                                    ? row.amount
                                                    : row.kind === 'expense'
                                                      ? -row.amount
                                                      : 0),
                                            0
                                        ),
                                        base.config.currency
                                    )}
                                </span>
                            </h4>
                            <ul className={styles.rows}>
                                {entries.map((row) => {
                                    const category = categoryOf(base.categories, row.categoryId);
                                    return (
                                        <li key={row.id} className={styles.row}>
                                            <button
                                                type='button'
                                                className={styles.rowClear}
                                                title={row.cleared ? 'Dépointer' : 'Pointer (vu sur le relevé)'}
                                                aria-label={row.cleared ? 'Dépointer' : 'Pointer'}
                                                aria-pressed={row.cleared}
                                                disabled={!base.canWrite || busy}
                                                onClick={() => void toggleCleared(row)}
                                            >
                                                <span
                                                    className={`icon icon-${row.cleared ? 'square-check' : 'square-empty'}`}
                                                />
                                            </button>

                                            <button
                                                type='button'
                                                className={styles.rowBody}
                                                onClick={() => base.canWrite && onEdit(row)}
                                                disabled={!base.canWrite}
                                            >
                                                <span
                                                    className={`icon icon-${row.kind === 'transfer' ? 'move-to-right' : (category?.icon ?? 'other')} ${styles.rowIcon}`}
                                                    style={{
                                                        color: category ? colorVar(category.color) : undefined
                                                    }}
                                                />
                                                <span className={styles.rowText}>
                                                    <span className={styles.rowLabel}>
                                                        {row.label || 'Sans intitulé'}
                                                        {row.recurringId !== null && (
                                                            <span
                                                                className={`icon icon-clock ${styles.rowBadge}`}
                                                                title='Écrite par une échéance'
                                                            />
                                                        )}
                                                    </span>
                                                    <span className={styles.rowMeta}>
                                                        {row.kind === 'transfer'
                                                            ? `${accountName(base.accounts, row.accountId)} vers ${accountName(base.accounts, row.transferAccountId)}`
                                                            : [
                                                                  accountName(base.accounts, row.accountId),
                                                                  category?.name,
                                                                  row.counterparty
                                                              ]
                                                                  .filter(Boolean)
                                                                  .join(' · ')}
                                                    </span>
                                                </span>
                                                <span
                                                    className={styles.rowAmount}
                                                    data-flow={
                                                        row.kind === 'income'
                                                            ? 'in'
                                                            : row.kind === 'expense'
                                                              ? 'out'
                                                              : undefined
                                                    }
                                                >
                                                    {row.kind === 'income' ? '+' : row.kind === 'expense' ? '−' : ''}
                                                    {formatMoney(row.amount, base.config.currency)}
                                                    {base.config.vatEnabled && row.vatAmount !== null && (
                                                        <span className={styles.rowVat}>
                                                            dont {formatMoney(row.vatAmount, base.config.currency)} de
                                                            TVA
                                                        </span>
                                                    )}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            {pages > 1 && (
                <div className={styles.pager}>
                    <Button
                        variant='ghost'
                        icon='arrow-left'
                        disabled={page === 0}
                        onClick={() => setPage((value) => Math.max(0, value - 1))}
                    >
                        Précédentes
                    </Button>
                    <span className={styles.pagerLabel}>
                        Page {page + 1} sur {pages}
                    </span>
                    <Button variant='ghost' disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>
                        Suivantes
                    </Button>
                </div>
            )}
        </div>
    );
}

export default Transactions;
