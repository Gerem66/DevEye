import { useCallback, useMemo, useState } from 'react';
import { Button, ErrorNote, SearchSelect, SegmentedControl, TextInput, useResource } from 'deveye-sdk-client';
import type { FinanceTransaction, FinanceTransactionKind } from '../contracts/domain';

import TransactionRow, { useClearedToggle } from './TransactionRow';
import { api } from './api';
import { formatDayHeading, formatMoney, formatSigned, shiftDays, todayIso } from './format';
import { accountName, categoryOf } from './shared';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

interface JournalProps {
    base: FinanceBase;
    /** Le compte d'une fiche : le filtre de compte disparaît, il est fixé. */
    accountId?: number;
    onEdit: (transaction: FinanceTransaction) => void;
}

/** Les fenêtres proposées, en jours de recul. `0` = tout l'historique. */
const WINDOWS = [
    { value: '30', label: '30 jours', days: 30 },
    { value: '90', label: '3 mois', days: 90 },
    { value: '365', label: '12 mois', days: 365 },
    { value: 'all', label: 'Tout', days: 0 }
] as const;

type WindowId = (typeof WINDOWS)[number]['value'];

const KINDS: { value: FinanceTransactionKind | 'all'; label: string }[] = [
    { value: 'all', label: 'Toutes' },
    { value: 'expense', label: 'Dépenses' },
    { value: 'income', label: 'Recettes' },
    { value: 'transfer', label: 'Virements' }
];

/** Combien de lignes par page. Le serveur plafonne à 500. */
const PAGE = 100;

interface Result {
    transactions: FinanceTransaction[];
    total: number;
    totals: { income: number; expense: number; net: number };
}

/**
 * Le journal. Compte, catégorie, nature et période sont filtrés en SQL ; la
 * recherche textuelle se fait dans le navigateur, sur ce qui est chargé
 * (intitulé et tiers sont chiffrés). Les totaux viennent du serveur et couvrent
 * tout le filtre, pas la page.
 */
export function Journal({ base, accountId: lockedAccountId, onEdit }: JournalProps) {
    const [windowId, setWindowId] = useState<WindowId>('90');
    const [pickedAccountId, setPickedAccountId] = useState<number | null>(null);
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const [kind, setKind] = useState<FinanceTransactionKind | 'all'>('all');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const cleared = useClearedToggle();

    const accountId = lockedAccountId ?? pickedAccountId;
    const days = WINDOWS.find((entry) => entry.value === windowId)?.days ?? 0;
    const from = days === 0 ? undefined : shiftDays(todayIso(), -days);

    const load = useCallback(async () => {
        const res = await api.send('finance.transactionList', {
            ...(accountId !== null ? { accountId } : {}),
            ...(categoryId !== null ? { categoryId } : {}),
            ...(kind !== 'all' ? { kind } : {}),
            ...(from ? { from } : {}),
            limit: PAGE,
            offset: page * PAGE
        });
        return res as Result;
    }, [accountId, categoryId, kind, from, page]);

    const { data, error, loading } = useResource<Result>('finance.transactionList', load, 'Chargement impossible.', [
        accountId,
        categoryId,
        kind,
        from,
        page
    ]);

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

    /**
     * Fabriqué dans le navigateur : les lignes y sont déjà déchiffrées. Porte
     * exactement ce qui est à l'écran, filtre et recherche compris.
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
                // Point décimal : le seul qu'aucun tableur ne prend pour un séparateur de colonnes.
                (row.amount / 100).toFixed(2),
                row.vatAmount === null ? '' : (row.vatAmount / 100).toFixed(2),
                row.cleared ? 'oui' : 'non'
            ].join(';')
        );
        // La marque d'ordre des octets : sans elle, Excel lit l'UTF-8 comme du
        // latin-1 et transforme chaque accent en deux caractères.
        const csv = `\uFEFF${[header.join(';'), ...lines].join('\r\n')}`;
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `operations-${todayIso()}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
    const currency = base.config.currency;
    const note = cleared.error ?? (error ? { message: error, code: null } : null);

    return (
        <div className={styles.page}>
            <div className={styles.filters}>
                <SegmentedControl
                    aria-label='Période'
                    value={windowId}
                    options={WINDOWS}
                    onChange={(value) => {
                        setWindowId(value);
                        setPage(0);
                    }}
                />

                {lockedAccountId === undefined && (
                    <SearchSelect
                        className={styles.filterSelect}
                        value={String(pickedAccountId ?? '')}
                        aria-label='Compte'
                        onChange={(value) => {
                            setPickedAccountId(value === '' ? null : Number(value));
                            setPage(0);
                        }}
                        options={[
                            { value: '', label: 'Tous les comptes' },
                            ...base.accounts.map((account) => ({
                                value: String(account.id),
                                label: account.name,
                                ...(account.archived ? { detail: 'archivé' } : {})
                            }))
                        ]}
                    />
                )}

                <SearchSelect
                    className={styles.filterSelect}
                    value={String(categoryId ?? '')}
                    aria-label='Catégorie'
                    onChange={(value) => {
                        setCategoryId(value === '' ? null : Number(value));
                        setPage(0);
                    }}
                    options={[
                        { value: '', label: 'Toutes les catégories' },
                        ...base.categories.map((category) => ({ value: String(category.id), label: category.name }))
                    ]}
                />

                <SegmentedControl
                    aria-label='Nature'
                    value={kind}
                    options={KINDS}
                    onChange={(value) => {
                        setKind(value);
                        setPage(0);
                    }}
                />

                <TextInput
                    className={styles.filterSearch}
                    type='search'
                    placeholder='Rechercher…'
                    aria-label='Rechercher dans les opérations chargées'
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />

                <Button
                    variant='ghost'
                    icon='download'
                    title='Les lignes affichées, en tableur (CSV)'
                    onClick={exportCsv}
                    disabled={rows.length === 0}
                >
                    Exporter
                </Button>
            </div>

            {data && (
                <div className={styles.totals}>
                    <span className={styles.totalIn}>+{formatMoney(data.totals.income, currency)}</span>
                    <span className={styles.totalOut}>
                        {'\u2212'}
                        {formatMoney(data.totals.expense, currency)}
                    </span>
                    <span className={styles.totalNet} data-negative={data.totals.net < 0 ? 'true' : undefined}>
                        {formatSigned(data.totals.net, currency)}
                    </span>
                    <span className={styles.totalsNote}>
                        {data.total} opération{data.total > 1 ? 's' : ''} dans ce filtre
                        {search.trim() !== '' && `, recherche sur les ${data.transactions.length} lignes chargées`}
                    </span>
                </div>
            )}

            <ErrorNote note={note} />

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
                            <h3 className={styles.dayHead}>
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
                                        currency
                                    )}
                                </span>
                            </h3>
                            <ul className={styles.rows}>
                                {entries.map((row) => (
                                    <li key={row.id}>
                                        <TransactionRow
                                            base={base}
                                            row={row}
                                            busy={cleared.busy}
                                            onToggleCleared={cleared.toggle}
                                            onOpen={onEdit}
                                        />
                                    </li>
                                ))}
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

export default Journal;
