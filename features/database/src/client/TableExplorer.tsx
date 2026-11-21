import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    errorNote,
    ErrorNote,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useRequestPopupWidth,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type {
    Database,
    DatabaseCombinator,
    DatabaseFilter,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from '../contracts/domain';

import { api } from './api';
import { CellEditor } from './CellEditor';
import { ExportDialog } from './ExportDialog';
import { Pagination } from './Pagination';
import { RowDialog } from './RowDialog';
import { SearchDialog } from './SearchDialog';
import { StructureDialog } from './StructureDialog';
import { TerminalDialog } from './TerminalDialog';
import { compareTables, FILTER_OPERATOR_LABELS, formatBytes, formatCount, OPERATOR_NEEDS_VALUE } from './format';
import { rowKey, rowKeyCells } from './rowKey';
import styles from './style.module.css';
import { useColumnResize } from './useColumnResize';

/** Les tailles de page offertes ; le contrat plafonne à la plus grande. */
const PAGE_SIZES = [25, 50, 100, 250, 500] as const;
const PAGE_OPTIONS = PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }));
/** Aligné sur le défaut du serveur. */
const PAGE_DEFAULT = 50;
/** Durée du halo d'une ligne qu'on vient de rejoindre. */
const HIGHLIGHT_MS = 3500;
/** En deçà, la liste des tables se parcourt d'un regard : pas de champ pour la filtrer. */
const FILTER_FROM = 10;

type Row = (string | null)[];

/** Une valeur binaire n'arrive qu'en aperçu : la réécrire remplacerait le binaire par son début. */
function isBinary(type: string): boolean {
    return /blob|binary|bytea/i.test(type);
}

/** Même table, par son nom. */
function sameTable(a: DatabaseTable | null, b: DatabaseTable | null): boolean {
    return a !== null && b !== null && a.schema === b.schema && a.name === b.name;
}

interface TableExplorerProps {
    database: Database;
    canWrite: boolean;
    /** Remplir la hauteur que l'appelant lui donne (l'onglet Tables), au lieu d'un écran à lui. */
    fill?: boolean;
    /** Gardé monté sous un autre onglet : l'inventaire chargé et la table ouverte y survivent. */
    hidden?: boolean;
}

/** Une seule popup à la fois. */
type Dialogue =
    | { kind: 'row'; row: { columns: string[]; values: Row } | null }
    | { kind: 'delete'; rows: Row[] }
    | { kind: 'structure' }
    | { kind: 'search' }
    | { kind: 'terminal' }
    | { kind: 'export' };

/**
 * L'exploration et l'administration des tables, dans un seul cadre : une barre
 * de gestes, la liste à gauche, la table ouverte à droite. Une cellule s'ouvre
 * au double-clic, sa ligne entière par le geste au bout d'elle. Modifier et
 * supprimer n'existent pas sur une table sans clé primaire. Les valeurs
 * restent des chaînes (voir `databaseRowsSchema`).
 */
export function TableExplorer({ database, canWrite, fill = false, hidden = false }: TableExplorerProps) {
    const { id: databaseId, name: databaseName } = database;
    /** Charger l'inventaire des tables dès qu'elles s'affichent : le réglage de la base. */
    const autoLoad = canWrite && database.autoLoadTables && !database.planPaused;
    const [tables, setTables] = useState<DatabaseTable[] | null>(null);
    /** Ce qu'on a tapé pour filtrer la liste des tables. */
    const [tableQuery, setTableQuery] = useState('');
    /** La table choisie dans la liste de gauche. */
    const [table, setTable] = useState<DatabaseTable | null>(null);
    /**
     * La table que `rows` et `structure` décrivent réellement : distincte de
     * `table` le temps d'un chargement, pour ne jamais annoncer une table en
     * montrant les lignes d'une autre.
     */
    const [shown, setShown] = useState<DatabaseTable | null>(null);
    /** Le même, lisible depuis une closure asynchrone. */
    const shownRef = useRef<DatabaseTable | null>(null);
    const [structure, setStructure] = useState<DatabaseStructure | null>(null);
    const [rows, setRows] = useState<DatabaseRows | null>(null);
    const [offset, setOffset] = useState(0);
    /** Lignes par page ; vaut d'une table à l'autre, le temps de l'écran. */
    const [pageSize, setPageSize] = useState(PAGE_DEFAULT);
    const [filters, setFilters] = useState<DatabaseFilter[]>([]);
    const [combinator, setCombinator] = useState<DatabaseCombinator>('and');
    const [sort, setSort] = useState<DatabaseSort | null>(null);
    /** Les lignes cochées de la page, par clé primaire ; une relecture les décoche. */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** La ligne rejointe par une clé étrangère, auréolée quelques secondes. */
    const [highlight, setHighlight] = useState<string | null>(null);
    const [dialogue, setDialogue] = useState<Dialogue | null>(null);
    /** La cellule ouverte au double-clic : sa ligne, son rang, sa boîte à l'écran. */
    const [cell, setCell] = useState<{ row: Row; index: number; anchor: DOMRect } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLTableElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const { widths, reset: resetWidths, grip } = useColumnResize(gridRef);

    /**
     * La largeur que la popup doit prendre pour montrer la table ouverte en
     * entier ; `null` = largeur commune. Le store ne descend jamais sous
     * 1240 px et écrête à la fenêtre.
     */
    const [wantedWidth, setWantedWidth] = useState<number | null>(null);
    useRequestPopupWidth(hidden ? null : wantedWidth);

    /**
     * Une cible absolue (tableau plus habillage), pas un ajustement relatif :
     * la popup s'élargit par une transition CSS, une mesure en plein vol
     * ajouterait deux fois le même manque. Le tableau occupe au moins sa boîte :
     * la cible ne redescend pas d'une table à l'autre, la popup ne s'élargit
     * que pour une table plus large que les précédentes.
     */
    useLayoutEffect(() => {
        const box = scrollRef.current;
        const grid = box?.querySelector('table');
        // Hors d'une popup de feature, on ne demande rien.
        const frame = box?.closest<HTMLElement>('[data-popup-frame]');
        if (!box || !grid || !frame) return;
        setWantedWidth(grid.scrollWidth + frame.clientWidth - box.clientWidth);
    }, [rows]);

    // Changer de base referme tout.
    useEffect(() => {
        setTables(null);
        setTableQuery('');
        setTable(null);
        setShown(null);
        shownRef.current = null;
        setStructure(null);
        setRows(null);
        setOffset(0);
        setFilters([]);
        setSort(null);
        setSelected(new Set());
        setError(null);
        setWantedWidth(null);
        resetWidths();
    }, [databaseId, resetWidths]);

    useEffect(() => () => (highlightTimer.current ? clearTimeout(highlightTimer.current) : undefined), []);

    /** Rend `false` sur un échec, déjà affiché. */
    const loadTables = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.tableList', { databaseId });
            // Rangées une fois pour toutes : la liste, l'export et le suivi
            // d'une clé étrangère lisent celle-ci.
            setTables([...res.tables].sort(compareTables));
            return true;
        } catch (e) {
            setError(errorNote(e, 'Impossible de lire les tables.'));
            return false;
        } finally {
            setBusy(false);
        }
    }, [databaseId]);

    /**
     * L'inventaire part seul au premier affichage des tables, une fois par
     * base : après un échec, c'est le bouton qui réessaie. Avant la peinture,
     * pour que l'attente s'affiche d'emblée à la place de l'invite.
     */
    const autoLoaded = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (!autoLoad || hidden || autoLoaded.current === databaseId) return;
        autoLoaded.current = databaseId;
        void loadTables();
    }, [autoLoad, hidden, databaseId, loadTables]);

    /** `withStructure` à la première lecture : structure et page dans la même session. */
    const loadRows = useCallback(
        async (
            target: DatabaseTable,
            at: number,
            options: {
                filters?: DatabaseFilter[];
                combinator?: DatabaseCombinator;
                sort?: DatabaseSort | null;
                limit?: number;
                withStructure?: boolean;
            } = {}
        ) => {
            setBusy(true);
            setError(null);
            try {
                const nextFilters = options.filters ?? filters;
                const nextSort = options.sort === undefined ? sort : options.sort;
                const res = await api.send('database.tableRows', {
                    databaseId,
                    schema: target.schema,
                    table: target.name,
                    offset: at,
                    limit: options.limit ?? pageSize,
                    ...(nextFilters.length > 0
                        ? { filters: nextFilters, combinator: options.combinator ?? combinator }
                        : {}),
                    ...(nextSort ? { sort: nextSort } : {}),
                    ...(options.withStructure ? { withStructure: true } : {})
                });
                // D'un bloc : l'écran ne montre jamais les lignes d'une table
                // sous le nom d'une autre.
                setRows(res.rows);
                setOffset(at);
                setSelected(new Set());
                shownRef.current = target;
                setShown(target);
                if (res.structure) setStructure(res.structure);
            } catch (e) {
                setError(errorNote(e, 'Impossible de lire cette table.'));
                // Un échec en changeant de table ne doit pas laisser le contenu
                // de la précédente passer pour celui de la nouvelle ; un échec
                // de pagination garde la page affichée, toujours juste.
                if (!sameTable(shownRef.current, target)) {
                    setRows(null);
                    setStructure(null);
                    shownRef.current = null;
                    setShown(null);
                }
            } finally {
                setBusy(false);
            }
        },
        [databaseId, filters, combinator, sort, pageSize]
    );

    /**
     * Ouvre une table : ses critères repartent de zéro, son contenu reste sous
     * le voile jusqu'à l'arrivée des lignes, pour que le cadre ne sursaute pas.
     */
    const open = useCallback(
        (target: DatabaseTable, nextFilters: DatabaseFilter[] = []) => {
            setTable(target);
            setFilters(nextFilters);
            setCombinator('and');
            setSort(null);
            resetWidths();
            void loadRows(target, 0, { filters: nextFilters, combinator: 'and', sort: null, withStructure: true });
        },
        [loadRows, resetWidths]
    );

    /**
     * La table ouverte se montre dans la liste : une clé étrangère peut en
     * ouvrir une hors champ. `scrollTo` sur la liste et non `scrollIntoView`,
     * qui ferait aussi défiler la popup.
     */
    useEffect(() => {
        const list = listRef.current;
        const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
        if (!list || !current) return;
        const box = list.getBoundingClientRect();
        const item = current.getBoundingClientRect();
        if (item.top >= box.top && item.bottom <= box.bottom) return;
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        list.scrollTo({ top: list.scrollTop + item.top - box.top - (box.height - item.height) / 2, behavior });
    }, [table]);

    /** Relit ce qui est à l'écran : l'inventaire, puis la page de la table ouverte. */
    const reload = async () => {
        if ((await loadTables()) && table) await loadRows(table, offset);
    };

    /** Change la taille des pages, en gardant sous les yeux la première ligne affichée. */
    const resize = (size: number) => {
        setPageSize(size);
        if (table) void loadRows(table, Math.floor(offset / size) * size, { limit: size });
    };

    /**
     * Suivre une clé étrangère : la table visée s'ouvre filtrée sur la valeur
     * pointée (calculer la page supposerait un ordre stable et une clé d'une
     * colonne), et la ligne s'auréole quelques secondes.
     */
    const followForeignKey = (refSchema: string, refTable: string, refColumn: string, value: string) => {
        const target = tables?.find((t) => t.name === refTable && (refSchema === '' || t.schema === refSchema));
        if (!target) {
            setError({ message: `La table « ${refTable} » n’est pas dans la liste chargée.`, code: 'not_found' });
            return;
        }
        open(target, [{ column: refColumn, operator: 'eq', value }]);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        setHighlight(value);
        highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    };

    /** La clé étrangère dont cette colonne fait partie, s'il y en a une. */
    const foreignKeyOf = (column: string) => structure?.foreignKeys.find((fk) => fk.columns.includes(column)) ?? null;

    const query = tableQuery.trim().toLowerCase();
    const listed = (tables ?? []).filter((t) => t.name.toLowerCase().includes(query));

    const total = rows?.total ?? null;
    // Sans `total`, une page pleine en suppose une suivante, une page entamée
    // est la dernière.
    const pageCount =
        total === null
            ? Math.floor(offset / pageSize) + ((rows?.rows.length ?? 0) < pageSize ? 1 : 2)
            : Math.max(1, Math.ceil(total / pageSize));
    const writable = structure !== null && structure.primaryKey.length > 0;
    const pageKeys = (rows?.rows ?? []).map((row) => rowKey(structure, rows?.columns ?? [], row));
    const selectedRows = (rows?.rows ?? []).filter((_, i) => {
        const key = pageKeys[i];
        return key !== null && selected.has(key);
    });

    const toggleRow = (key: string) =>
        setSelected((set) => {
            const next = new Set(set);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const remove = async (targets: Row[]) => {
        if (!table || !rows) return;
        const keys = targets
            .map((row) => rowKeyCells(structure, rows.columns, row))
            .filter((cells): cells is NonNullable<typeof cells> => cells !== null);
        if (keys.length === 0) return;

        setBusy(true);
        try {
            await api.send('database.rowDelete', {
                databaseId,
                schema: table.schema,
                table: table.name,
                keys
            });
            await loadRows(table, offset);
        } catch (e) {
            setError(errorNote(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /** Pourquoi la cellule ouverte ne se modifie pas ici ; `null` = elle se modifie. */
    const lockOf = (column: string, row: Row): string | null => {
        if (!structure || rowKeyCells(structure, rows?.columns ?? [], row) === null) {
            return 'Table sans clé primaire : ses lignes ne se modifient pas ici.';
        }
        if (structure.primaryKey.includes(column)) {
            return 'Colonne de la clé primaire : elle désigne la ligne, seul le terminal la change.';
        }
        const type = structure.columns.find((c) => c.name === column)?.type;
        return type && isBinary(type) ? 'Valeur binaire : seul son début est affiché.' : null;
    };

    const saveCell = async (value: string | null) => {
        if (!table || !rows || !cell) return;
        const key = rowKeyCells(structure, rows.columns, cell.row);
        if (!key) return;
        await api.send('database.rowUpdate', {
            databaseId,
            schema: table.schema,
            table: table.name,
            key,
            values: [{ column: rows.columns[cell.index], value }]
        });
        setCell(null);
        await loadRows(table, offset);
    };

    /** Ce que la confirmation dit d'une suppression : la ligne par sa clé, ou leur nombre. */
    const deletion = (targets: Row[]) => {
        const key = targets.length === 1 ? rowKeyCells(structure, rows?.columns ?? [], targets[0]) : null;
        return {
            title: targets.length > 1 ? `Supprimer ${targets.length} lignes ?` : 'Supprimer cette ligne ?',
            description: (
                <>
                    {key ? (
                        <>
                            La ligne <code>{key.map((c) => `${c.column} = ${c.value ?? 'NULL'}`).join(', ')}</code> est
                            supprimée
                        </>
                    ) : (
                        'Ces lignes sont supprimées'
                    )}{' '}
                    de <strong>{table?.name}</strong>, sur le serveur, immédiatement. DevEye ne sait pas revenir en
                    arrière : seule une sauvegarde du serveur le permettrait.
                </>
            ),
            onConfirm: () => void remove(targets)
        };
    };

    /** L'attente du tout premier inventaire, et de lui seul. */
    const loadingTables = tables === null && busy;
    const editing = cell && rows ? rows.columns[cell.index] : null;
    const editingMeta = structure?.columns.find((c) => c.name === editing) ?? null;
    /** Les colonnes hors données, en tête et en queue : elles décalent le rang d'une poignée. */
    const lead = writable ? 1 : 0;

    return (
        <section hidden={hidden} className={fill ? styles.explorerFill : styles.explorerPanel}>
            <header className={styles.explorerHead}>
                <div className={styles.explorerTitle}>
                    {shown && rows ? (
                        <>
                            <span className={styles.tableName}>{shown.name}</span>
                            <span className={styles.hint}>
                                {total === null
                                    ? `${rows.rows.length} lignes`
                                    : `${total === 0 ? 0 : offset + 1}–${Math.min(offset + pageSize, total)} sur ${formatCount(total)}`}
                                {' · '}
                                {rows.elapsedMs} ms
                            </span>
                        </>
                    ) : (
                        <h3 className={styles.panelTitle}>Tables</h3>
                    )}
                </div>

                <div className={styles.actions}>
                    {selectedRows.length > 0 && (
                        <Button
                            variant='danger'
                            icon='trash'
                            onClick={() => setDialogue({ kind: 'delete', rows: selectedRows })}
                            disabled={busy}
                        >
                            Supprimer ({selectedRows.length})
                        </Button>
                    )}
                    <Button
                        variant='secondary'
                        icon='terminal'
                        onClick={() => setDialogue({ kind: 'terminal' })}
                        disabled={busy}
                    >
                        Terminal
                    </Button>
                    {shown && rows && (
                        <>
                            <Button
                                variant='secondary'
                                icon='search'
                                onClick={() => setDialogue({ kind: 'search' })}
                                disabled={busy || !structure}
                            >
                                Rechercher
                            </Button>
                            <Button
                                variant='secondary'
                                icon='details'
                                onClick={() => setDialogue({ kind: 'structure' })}
                                disabled={busy || !structure}
                            >
                                Structure
                            </Button>
                            <Button
                                variant='secondary'
                                icon='add'
                                onClick={() => setDialogue({ kind: 'row', row: null })}
                                disabled={busy || !structure}
                            >
                                Ajouter une ligne
                            </Button>
                        </>
                    )}
                    {tables !== null && (
                        <Button
                            variant='secondary'
                            icon='refresh'
                            title='Relire la liste des tables et la page affichée'
                            onClick={() => void reload()}
                            disabled={busy}
                        >
                            Recharger
                        </Button>
                    )}
                </div>
            </header>

            <ErrorNote note={error} />

            {loadingTables && (
                <p className={styles.rowsIdle}>
                    <span className='icon icon-spinner' aria-hidden='true' />
                    Lecture des tables…
                </p>
            )}

            {tables === null && !busy && (
                <div className={styles.explorerIdle}>
                    <p className={styles.hint}>
                        Les tables ne sont pas chargées.
                        {!database.autoLoadTables &&
                            ' Leur chargement dès l’affichage se règle dans « Réglages » (Général).'}
                    </p>
                    <Button icon='refresh' onClick={() => void loadTables()}>
                        Charger les tables
                    </Button>
                </div>
            )}

            {tables?.length === 0 && <p className={styles.rowsIdle}>Cette base ne contient aucune table.</p>}

            {tables && tables.length > 0 && (
                <div className={styles.explorer}>
                    <div className={styles.tableSide}>
                        {tables.length > FILTER_FROM && (
                            <TextInput
                                value={tableQuery}
                                placeholder='Filtrer les tables'
                                aria-label='Filtrer les tables'
                                onChange={(e) => setTableQuery(e.target.value)}
                                onClear={() => setTableQuery('')}
                            />
                        )}
                        {/* La boîte s'étire à la hauteur de la ligne : une colonne
                            aussi haute que sa voisine sans hauteur en dur. */}
                        <div className={styles.tableListPane}>
                            {listed.length === 0 ? (
                                <p className={styles.hint}>Aucune table à ce nom.</p>
                            ) : (
                                <ul ref={listRef} className={styles.tableList}>
                                    {listed.map((item) => (
                                        <li key={`${item.schema}.${item.name}`}>
                                            <button
                                                type='button'
                                                className={
                                                    sameTable(table, item) ? styles.tableItemOn : styles.tableItem
                                                }
                                                aria-current={sameTable(table, item) ? 'true' : undefined}
                                                onClick={() => open(item)}
                                            >
                                                <span className={styles.tableName}>{item.name}</span>
                                                <span className={styles.tableMeta}>
                                                    {formatCount(item.rowCount)} l. · {formatBytes(item.sizeBytes)}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>

                    <div className={styles.rowsPane}>
                        {!table && <p className={styles.rowsIdle}>Choisissez une table pour en voir le contenu.</p>}

                        {/* La toute première lecture n'a rien à voiler. */}
                        {table && !shown && busy && (
                            <p className={styles.rowsIdle}>
                                <span className='icon icon-spinner' aria-hidden='true' />
                                Lecture de {table.name}…
                            </p>
                        )}

                        {table && shown && rows && (
                            <>
                                {/* Le voile couvre le contenu précédent au lieu de le
                                    remplacer : la hauteur du cadre ne bouge pas. */}
                                {busy && (
                                    <div className={styles.tableVeil} aria-hidden='true'>
                                        <span className='icon icon-spinner' />
                                    </div>
                                )}

                                {!writable && structure && (
                                    <p className={styles.rowsNote}>
                                        Cette table n’a pas de clé primaire : DevEye ne peut pas désigner une ligne
                                        précise, et n’y propose donc ni modification ni suppression.
                                    </p>
                                )}

                                {filters.length > 0 && (
                                    <div className={styles.filterBar}>
                                        {filters.map((filter, i) => (
                                            <span key={i} className={styles.filterChip}>
                                                {filter.column} {FILTER_OPERATOR_LABELS[filter.operator]}
                                                {OPERATOR_NEEDS_VALUE[filter.operator] && ` « ${filter.value} »`}
                                            </span>
                                        ))}
                                        <span className={styles.hint}>
                                            {filters.length > 1 && (combinator === 'and' ? 'tous' : 'au moins un')}
                                        </span>
                                        <button
                                            type='button'
                                            className={styles.filterClear}
                                            onClick={() => {
                                                setFilters([]);
                                                void loadRows(table, 0, { filters: [] });
                                            }}
                                        >
                                            Retirer les critères
                                        </button>
                                    </div>
                                )}

                                <div ref={scrollRef} className={styles.rowsScrollPane}>
                                    <table
                                        ref={gridRef}
                                        className={widths ? styles.dataTableSized : styles.dataTable}
                                        style={widths ? { width: widths.reduce((sum, w) => sum + w, 0) } : undefined}
                                    >
                                        {/* Une par colonne de l'en-tête : la poignée écrit sa largeur ici. */}
                                        <colgroup>
                                            {Array.from({ length: rows.columns.length + 2 * lead }, (_, i) => (
                                                <col key={i} style={widths ? { width: widths[i] } : undefined} />
                                            ))}
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                {writable && (
                                                    <th className={styles.selectCell}>
                                                        <Checkbox
                                                            aria-label='Tout sélectionner sur cette page'
                                                            checked={
                                                                selectedRows.length > 0 &&
                                                                selectedRows.length === rows.rows.length
                                                            }
                                                            onChange={(checked) =>
                                                                setSelected(
                                                                    new Set(
                                                                        checked
                                                                            ? pageKeys.filter((key) => key !== null)
                                                                            : []
                                                                    )
                                                                )
                                                            }
                                                        />
                                                    </th>
                                                )}
                                                {rows.columns.map((column, j) => {
                                                    const active = sort?.column === column;
                                                    return (
                                                        <th key={column}>
                                                            <button
                                                                type='button'
                                                                className={styles.sortButton}
                                                                title='Trier sur cette colonne'
                                                                onClick={() => {
                                                                    const next: DatabaseSort = {
                                                                        column,
                                                                        direction:
                                                                            active && sort?.direction === 'asc'
                                                                                ? 'desc'
                                                                                : 'asc'
                                                                    };
                                                                    setSort(next);
                                                                    void loadRows(table, 0, { sort: next });
                                                                }}
                                                            >
                                                                {column}
                                                                {active && (
                                                                    <span aria-hidden='true'>
                                                                        {sort?.direction === 'asc' ? ' ↑' : ' ↓'}
                                                                    </span>
                                                                )}
                                                            </button>
                                                            <span
                                                                className={styles.columnGrip}
                                                                title='Glisser pour redimensionner ; double-clic pour revenir aux largeurs automatiques'
                                                                {...grip(j + lead)}
                                                            />
                                                        </th>
                                                    );
                                                })}
                                                {writable && (
                                                    <th
                                                        className={styles.rowActionsCell}
                                                        aria-label='Gestes sur la ligne'
                                                    />
                                                )}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.rows.map((row, i) => {
                                                const key = pageKeys[i];
                                                const halo =
                                                    highlight !== null && row.some((value) => value === highlight);
                                                return (
                                                    <tr key={key ?? i} className={halo ? styles.rowHalo : undefined}>
                                                        {writable && (
                                                            <td className={styles.selectCell}>
                                                                {key !== null && (
                                                                    <Checkbox
                                                                        aria-label='Sélectionner cette ligne'
                                                                        checked={selected.has(key)}
                                                                        onChange={() => toggleRow(key)}
                                                                    />
                                                                )}
                                                            </td>
                                                        )}
                                                        {row.map((value, j) => {
                                                            const column = rows.columns[j];
                                                            const fk = value === null ? null : foreignKeyOf(column);
                                                            const at = fk ? fk.columns.indexOf(column) : -1;
                                                            return (
                                                                <td
                                                                    key={j}
                                                                    className={
                                                                        value === null
                                                                            ? `${styles.cell} ${styles.nullCell}`
                                                                            : styles.cell
                                                                    }
                                                                    onDoubleClick={(event) =>
                                                                        setCell({
                                                                            row,
                                                                            index: j,
                                                                            anchor: event.currentTarget.getBoundingClientRect()
                                                                        })
                                                                    }
                                                                >
                                                                    {fk && value !== null ? (
                                                                        <button
                                                                            type='button'
                                                                            className={styles.foreignLink}
                                                                            title={`Voir ${fk.refTable}.${fk.refColumns[at]} = ${value}`}
                                                                            onClick={() =>
                                                                                followForeignKey(
                                                                                    fk.refSchema,
                                                                                    fk.refTable,
                                                                                    fk.refColumns[at],
                                                                                    value
                                                                                )
                                                                            }
                                                                        >
                                                                            {value}
                                                                        </button>
                                                                    ) : (
                                                                        (value ?? 'NULL')
                                                                    )}
                                                                </td>
                                                            );
                                                        })}
                                                        {writable && (
                                                            <td className={styles.rowActionsCell}>
                                                                {key !== null && (
                                                                    <span className={styles.rowActions}>
                                                                        <button
                                                                            type='button'
                                                                            className={shell.rowAction}
                                                                            title='Modifier la ligne'
                                                                            aria-label='Modifier la ligne'
                                                                            onClick={() =>
                                                                                setDialogue({
                                                                                    kind: 'row',
                                                                                    row: {
                                                                                        columns: rows.columns,
                                                                                        values: row
                                                                                    }
                                                                                })
                                                                            }
                                                                        >
                                                                            <span className='icon icon-edit' />
                                                                        </button>
                                                                        <button
                                                                            type='button'
                                                                            className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                                                            title='Supprimer la ligne'
                                                                            aria-label='Supprimer la ligne'
                                                                            onClick={() =>
                                                                                setDialogue({
                                                                                    kind: 'delete',
                                                                                    rows: [row]
                                                                                })
                                                                            }
                                                                        >
                                                                            <span className='icon icon-trash' />
                                                                        </button>
                                                                    </span>
                                                                )}
                                                            </td>
                                                        )}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>

                                    {rows.rows.length === 0 && (
                                        <p className={styles.rowsIdle}>
                                            {filters.length > 0
                                                ? 'Aucune ligne ne répond à ces critères.'
                                                : 'Aucune ligne à cet endroit.'}
                                        </p>
                                    )}
                                </div>

                                <div className={styles.rowsFoot}>
                                    <div className={styles.pageSize}>
                                        <span className={styles.hint}>Lignes par page</span>
                                        <SegmentedControl
                                            aria-label='Lignes par page'
                                            options={PAGE_OPTIONS}
                                            value={String(pageSize)}
                                            disabled={busy}
                                            onChange={(size) => resize(Number(size))}
                                        />
                                    </div>
                                    <Pagination
                                        page={Math.floor(offset / pageSize) + 1}
                                        pageCount={pageCount}
                                        disabled={busy}
                                        onGo={(page) => void loadRows(table, (page - 1) * pageSize)}
                                    />
                                    <Button
                                        variant='secondary'
                                        icon='download'
                                        className={styles.rowsFootEnd}
                                        title='Exporter cette table, ou toute la base'
                                        onClick={() => setDialogue({ kind: 'export' })}
                                        disabled={busy}
                                    >
                                        Exporter
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {cell && editing !== null && (
                <CellEditor
                    anchor={cell.anchor}
                    column={editing}
                    type={editingMeta?.type ?? null}
                    value={cell.row[cell.index]}
                    nullable={editingMeta?.nullable ?? false}
                    locked={lockOf(editing, cell.row)}
                    onSave={saveCell}
                    onClose={() => setCell(null)}
                />
            )}

            {structure && (
                <>
                    <RowDialog
                        open={dialogue?.kind === 'row'}
                        databaseId={databaseId}
                        structure={structure}
                        row={dialogue?.kind === 'row' ? dialogue.row : null}
                        onClose={() => setDialogue(null)}
                        onSaved={() => {
                            setDialogue(null);
                            if (table) void loadRows(table, offset);
                        }}
                    />
                    <StructureDialog
                        open={dialogue?.kind === 'structure'}
                        structure={structure}
                        onClose={() => setDialogue(null)}
                        onOpenTable={(schema, name) => {
                            const target = tables?.find(
                                (t) => t.name === name && (schema === '' || t.schema === schema)
                            );
                            setDialogue(null);
                            if (target) open(target);
                        }}
                    />
                    <SearchDialog
                        open={dialogue?.kind === 'search'}
                        structure={structure}
                        filters={filters}
                        combinator={combinator}
                        onClose={() => setDialogue(null)}
                        onApply={(next, mode) => {
                            setDialogue(null);
                            setFilters(next);
                            setCombinator(mode);
                            if (table) void loadRows(table, 0, { filters: next, combinator: mode });
                        }}
                    />
                </>
            )}

            <TerminalDialog
                open={dialogue?.kind === 'terminal'}
                databaseId={databaseId}
                databaseName={databaseName}
                onClose={() => setDialogue(null)}
                onWrote={() => {
                    if (table) void loadRows(table, offset);
                }}
            />

            <ExportDialog
                open={dialogue?.kind === 'export'}
                databaseId={databaseId}
                tables={tables}
                table={table}
                onClose={() => setDialogue(null)}
            />

            <ConfirmDialog
                request={dialogue?.kind === 'delete' ? deletion(dialogue.rows) : null}
                onClose={() => setDialogue(null)}
            />
        </section>
    );
}

export default TableExplorer;
