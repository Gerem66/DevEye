import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Button, Checkbox, Dialog, humanizeError, useRequestPopupWidth } from 'deveye-sdk-client';
import type {
    DatabaseCombinator,
    DatabaseFilter,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from '../contracts/domain';

import { api } from './api';
import { ExportDialog } from './ExportDialog';
import { Pagination } from './Pagination';
import { RowDialog } from './RowDialog';
import { SearchDialog } from './SearchDialog';
import { StructureDialog } from './StructureDialog';
import { TerminalDialog } from './TerminalDialog';
import { compareTables, FILTER_OPERATOR_LABELS, formatBytes, formatCount, OPERATOR_NEEDS_VALUE } from './format';
import { rowKey, rowKeyCells } from './rowKey';
import styles from './style.module.css';

/** Lignes par page, aligné sur le défaut du serveur. */
const PAGE = 50;
/** Durée du halo d'une ligne qu'on vient de rejoindre. */
const HIGHLIGHT_MS = 3500;

/** Le ressort de l'agrandissement : ferme, et amorti pour ne pas rebondir. */
const EXPAND_SPRING = { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 } as const;

/**
 * Le temps que la disposition met à se poser après un agrandissement : calé sur
 * `--transition-slow` (400 ms), qui referme la colonne des tables, plus une marge.
 */
const SETTLE_MS = 450;

/** Même table, par son nom. */
function sameTable(a: DatabaseTable | null, b: DatabaseTable | null): boolean {
    return a !== null && b !== null && a.schema === b.schema && a.name === b.name;
}

interface TableExplorerProps {
    databaseId: number;
    databaseName: string;
    /** Charger l'inventaire des tables dès l'affichage (réglage de la base). */
    autoLoad: boolean;
    /** La table ouverte occupe toute la popup ; piloté par l'appelant. */
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

/** Une seule popup à la fois. */
type Dialogue =
    | { kind: 'row'; row: { columns: string[]; values: (string | null)[] } | null }
    | { kind: 'structure' }
    | { kind: 'search' }
    | { kind: 'terminal' }
    | { kind: 'export' }
    | { kind: 'delete' };

/**
 * L'exploration et l'administration des tables. Rien ne part sans clic, sauf
 * `autoLoad`. Modifier et supprimer n'existent pas sur une table sans clé
 * primaire. Les valeurs restent des chaînes (voir `databaseRowsSchema`).
 */
export function TableExplorer({ databaseId, databaseName, autoLoad, expanded, onExpandedChange }: TableExplorerProps) {
    const [tables, setTables] = useState<DatabaseTable[] | null>(null);
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
    const [filters, setFilters] = useState<DatabaseFilter[]>([]);
    const [combinator, setCombinator] = useState<DatabaseCombinator>('and');
    const [sort, setSort] = useState<DatabaseSort | null>(null);
    /** Les lignes cochées, par clé primaire (un indice ne survit pas au tri). */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** La ligne rejointe par une clé étrangère, auréolée quelques secondes. */
    const [highlight, setHighlight] = useState<string | null>(null);
    const [dialogue, setDialogue] = useState<Dialogue | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Le plein écran était déjà installé au rendu précédent. */
    const wasExpanded = useRef(false);

    /**
     * La largeur que la popup doit prendre pour montrer la table en entier, en
     * plein écran seulement ; `null` = largeur commune. Le store ne descend
     * jamais sous 1240 px et écrête à la fenêtre.
     */
    const [wantedWidth, setWantedWidth] = useState<number | null>(null);
    useRequestPopupWidth(expanded ? wantedWidth : null);

    /**
     * Une cible absolue (tableau plus habillage), pas un ajustement relatif :
     * la popup s'élargit par une transition CSS, une mesure en plein vol
     * ajouterait deux fois le même manque. À l'entrée en plein écran, on attend
     * que la colonne des tables se soit refermée pour mesurer l'habillage.
     */
    useLayoutEffect(() => {
        if (!expanded) {
            wasExpanded.current = false;
            setWantedWidth(null);
            return;
        }
        const measure = () => {
            const box = scrollRef.current;
            const grid = box?.querySelector('table');
            // Hors d'une popup de feature, on ne demande rien.
            const frame = box?.closest<HTMLElement>('[data-popup-frame]');
            if (!box || !grid || !frame) return;
            const chrome = frame.clientWidth - box.clientWidth;
            setWantedWidth(Math.min(grid.scrollWidth + chrome, window.innerWidth));
        };

        if (wasExpanded.current) {
            measure();
            return;
        }
        wasExpanded.current = true;
        const timer = setTimeout(measure, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [expanded, rows, table]);

    // Changer de base referme tout, plein écran compris.
    useEffect(() => {
        setTables(null);
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
        onExpandedChange(false);
    }, [databaseId, onExpandedChange]);

    useEffect(() => () => (highlightTimer.current ? clearTimeout(highlightTimer.current) : undefined), []);

    const loadTables = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('database.tableList', { databaseId });
            // Rangées une fois pour toutes : la liste, l'export et le suivi
            // d'une clé étrangère lisent celle-ci.
            setTables([...res.tables].sort(compareTables));
        } catch (e) {
            setError(humanizeError(e, 'Impossible de lire les tables.'));
        } finally {
            setBusy(false);
        }
    }, [databaseId]);

    // Le seul endroit où une connexion part sans clic, si la base le demande.
    useEffect(() => {
        if (autoLoad) void loadTables();
    }, [autoLoad, loadTables]);

    /** `withStructure` à la première lecture : structure et page dans la même session. */
    const loadRows = useCallback(
        async (
            target: DatabaseTable,
            at: number,
            options: {
                filters?: DatabaseFilter[];
                combinator?: DatabaseCombinator;
                sort?: DatabaseSort | null;
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
                    limit: PAGE,
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
                shownRef.current = target;
                setShown(target);
                if (res.structure) setStructure(res.structure);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de lire cette table.'));
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
        [databaseId, filters, combinator, sort]
    );

    /**
     * Ouvre une table : ses critères repartent de zéro, son contenu reste sous
     * le voile jusqu'à l'arrivée des lignes, pour que le panneau ne sursaute pas.
     */
    const open = useCallback(
        (target: DatabaseTable, nextFilters: DatabaseFilter[] = []) => {
            setTable(target);
            setSelected(new Set());
            setFilters(nextFilters);
            setCombinator('and');
            setSort(null);
            void loadRows(target, 0, { filters: nextFilters, combinator: 'and', sort: null, withStructure: true });
        },
        [loadRows]
    );

    /**
     * Suivre une clé étrangère : la table visée s'ouvre filtrée sur la valeur
     * pointée (calculer la page supposerait un ordre stable et une clé d'une
     * colonne), et la ligne s'auréole quelques secondes.
     */
    const followForeignKey = (refSchema: string, refTable: string, refColumn: string, value: string) => {
        const target = tables?.find((t) => t.name === refTable && (refSchema === '' || t.schema === refSchema));
        if (!target) {
            setError(`La table « ${refTable} » n’est pas dans la liste chargée.`);
            return;
        }
        open(target, [{ column: refColumn, operator: 'eq', value }]);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        setHighlight(value);
        highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    };

    /** La clé étrangère dont cette colonne fait partie, s'il y en a une. */
    const foreignKeyOf = (column: string) => structure?.foreignKeys.find((fk) => fk.columns.includes(column)) ?? null;

    const total = rows?.total ?? null;
    // Sans `total`, une page pleine en suppose une suivante, une page entamée
    // est la dernière.
    const pageCount =
        total === null
            ? Math.floor(offset / PAGE) + ((rows?.rows.length ?? 0) < PAGE ? 1 : 2)
            : Math.max(1, Math.ceil(total / PAGE));
    const writable = structure !== null && structure.primaryKey.length > 0;
    const pageKeys = (rows?.rows ?? []).map((row) => rowKey(structure, rows?.columns ?? [], row));
    const selectedOnPage = pageKeys.filter((k) => k !== null && selected.has(k)).length;

    const toggleRow = (key: string) =>
        setSelected((set) => {
            const next = new Set(set);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const removeSelected = async () => {
        if (!table || !structure || !rows) return;
        const keys = rows.rows
            .filter((row) => {
                const key = rowKey(structure, rows.columns, row);
                return key !== null && selected.has(key);
            })
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
            setDialogue(null);
            setSelected(new Set());
            await loadRows(table, offset);
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
            setDialogue(null);
        } finally {
            setBusy(false);
        }
    };

    /** La ligne cochée, quand il n'y en a qu'une. */
    const singleSelectedRow = () => {
        if (!rows || selected.size !== 1) return null;
        const found = rows.rows.find((row) => {
            const key = rowKey(structure, rows.columns, row);
            return key !== null && selected.has(key);
        });
        return found ? { columns: rows.columns, values: found } : null;
    };

    return (
        /* `layout` : framer-motion mesure la boîte avant et après, et anime l'écart. */
        <motion.section
            layout
            transition={EXPAND_SPRING}
            className={expanded ? styles.panelExpanded : styles.panelGrow}
        >
            {!expanded && (
                /* `layout` sur chaque enfant animé : il reçoit l'échelle inverse
                   et n'est pas déformé pendant le mouvement. */
                <motion.header layout transition={EXPAND_SPRING} className={styles.panelHead}>
                    <h3 className={styles.panelTitle}>Tables</h3>
                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            icon='terminal'
                            onClick={() => setDialogue({ kind: 'terminal' })}
                            disabled={busy}
                        >
                            Terminal
                        </Button>
                        <Button
                            variant='secondary'
                            icon='download'
                            onClick={() => setDialogue({ kind: 'export' })}
                            disabled={busy}
                        >
                            Exporter
                        </Button>
                        <Button variant='secondary' icon='refresh' onClick={() => void loadTables()} disabled={busy}>
                            {tables === null ? 'Charger les tables' : 'Recharger'}
                        </Button>
                    </div>
                </motion.header>
            )}

            {error && <p className={styles.error}>{error}</p>}

            {tables === null && (
                <p className={styles.hint}>
                    Rien n’est chargé pour l’instant : la base n’est jointe qu’au moment où vous le demandez. Le
                    chargement à l’ouverture se règle dans « Réglages » (Général).
                </p>
            )}

            {tables?.length === 0 && <p className={styles.hint}>Cette base ne contient aucune table.</p>}

            {tables && tables.length > 0 && (
                <motion.div
                    layout
                    transition={EXPAND_SPRING}
                    className={expanded ? styles.explorerExpanded : styles.explorer}
                >
                    {/* La boîte s'étire à la hauteur de la ligne : une colonne
                        aussi haute que sa voisine sans hauteur en dur. */}
                    <div className={styles.tableListPane}>
                        <ul className={styles.tableList}>
                            {tables.map((item) => (
                                <li key={`${item.schema}.${item.name}`}>
                                    <button
                                        type='button'
                                        className={
                                            table?.name === item.name && table.schema === item.schema
                                                ? styles.tableItemOn
                                                : styles.tableItem
                                        }
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
                    </div>

                    <div className={styles.rowsPane}>
                        {!table && <p className={styles.hint}>Choisissez une table pour en voir le contenu.</p>}

                        {/* La toute première lecture n'a rien à voiler. */}
                        {table && !shown && busy && (
                            <p className={styles.loadingLine}>
                                <span className={`icon icon-spinner ${styles.spinning}`} aria-hidden='true' />
                                Lecture de {table.name}…
                            </p>
                        )}

                        {table && shown && rows && (
                            <motion.div layout transition={EXPAND_SPRING} className={styles.tablePanel}>
                                {/* Le voile couvre le contenu précédent au lieu de le
                                    remplacer : la hauteur du panneau ne bouge pas. */}
                                {busy && (
                                    <div className={styles.tableVeil} aria-hidden='true'>
                                        <span className={`icon icon-spinner ${styles.spinning}`} />
                                    </div>
                                )}
                                <div className={styles.rowsHead}>
                                    <span className={styles.tableName}>
                                        {expanded ? `${databaseName} · ${shown.name}` : shown.name}
                                    </span>
                                    <span className={styles.hint}>
                                        {total === null
                                            ? `${rows.rows.length} lignes`
                                            : `${total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE, total)} sur ${formatCount(total)}`}
                                        {' · '}
                                        {rows.elapsedMs} ms
                                        {selected.size > 0 &&
                                            ` · ${selected.size} sélectionnée${selected.size > 1 ? 's' : ''}`}
                                    </span>
                                </div>

                                <div className={styles.toolbar}>
                                    <Button
                                        variant='secondary'
                                        icon='add'
                                        onClick={() => setDialogue({ kind: 'row', row: null })}
                                        disabled={busy || !structure}
                                    >
                                        Ajouter
                                    </Button>
                                    <Button
                                        variant='secondary'
                                        icon='edit'
                                        onClick={() => {
                                            const row = singleSelectedRow();
                                            if (row) setDialogue({ kind: 'row', row });
                                        }}
                                        disabled={busy || !writable || selected.size !== 1}
                                    >
                                        Modifier
                                    </Button>
                                    <Button
                                        variant='danger'
                                        icon='trash'
                                        onClick={() => setDialogue({ kind: 'delete' })}
                                        disabled={busy || !writable || selectedOnPage === 0}
                                    >
                                        Supprimer
                                    </Button>

                                    <span className={styles.toolbarGap} />

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
                                        icon={expanded ? 'collapse' : 'expand'}
                                        title={
                                            expanded
                                                ? 'Rendre sa place au reste de la fiche'
                                                : 'Ne garder que cette table à l’écran'
                                        }
                                        onClick={() => onExpandedChange(!expanded)}
                                    >
                                        {expanded ? 'Réduire' : 'Agrandir'}
                                    </Button>
                                </div>

                                {!writable && structure && (
                                    <p className={styles.hint}>
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

                                <div
                                    ref={scrollRef}
                                    className={expanded ? styles.rowsScrollFill : styles.rowsScrollPane}
                                >
                                    <table className={styles.dataTable}>
                                        <thead>
                                            <tr>
                                                {writable && (
                                                    <th className={styles.selectCell}>
                                                        <Checkbox
                                                            aria-label='Tout sélectionner sur cette page'
                                                            checked={
                                                                selectedOnPage > 0 &&
                                                                selectedOnPage === rows.rows.length
                                                            }
                                                            onChange={(checked) =>
                                                                setSelected((set) => {
                                                                    const next = new Set(set);
                                                                    for (const key of pageKeys) {
                                                                        if (key === null) continue;
                                                                        if (checked) next.add(key);
                                                                        else next.delete(key);
                                                                    }
                                                                    return next;
                                                                })
                                                            }
                                                        />
                                                    </th>
                                                )}
                                                {rows.columns.map((column) => {
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
                                                        </th>
                                                    );
                                                })}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.rows.map((row, i) => {
                                                const key = pageKeys[i];
                                                const halo =
                                                    highlight !== null && row.some((cell) => cell === highlight);
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
                                                        {row.map((cell, j) => {
                                                            const column = rows.columns[j];
                                                            const fk = foreignKeyOf(column);
                                                            if (fk && cell !== null) {
                                                                const at = fk.columns.indexOf(column);
                                                                return (
                                                                    <td key={j}>
                                                                        <button
                                                                            type='button'
                                                                            className={styles.foreignLink}
                                                                            title={`Voir ${fk.refTable}.${fk.refColumns[at]} = ${cell}`}
                                                                            onClick={() =>
                                                                                followForeignKey(
                                                                                    fk.refSchema,
                                                                                    fk.refTable,
                                                                                    fk.refColumns[at],
                                                                                    cell
                                                                                )
                                                                            }
                                                                        >
                                                                            {cell}
                                                                        </button>
                                                                    </td>
                                                                );
                                                            }
                                                            return (
                                                                <td
                                                                    key={j}
                                                                    className={cell === null ? styles.nullCell : ''}
                                                                >
                                                                    {cell === null ? 'NULL' : cell}
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>

                                {rows.rows.length === 0 && (
                                    <p className={styles.hint}>
                                        {filters.length > 0
                                            ? 'Aucune ligne ne répond à ces critères.'
                                            : 'Aucune ligne à cet endroit.'}
                                    </p>
                                )}

                                <Pagination
                                    page={Math.floor(offset / PAGE) + 1}
                                    pageCount={pageCount}
                                    disabled={busy}
                                    onGo={(page) => void loadRows(table, (page - 1) * PAGE)}
                                />
                            </motion.div>
                        )}
                    </div>
                </motion.div>
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
                            setSelected(new Set());
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
                            setSelected(new Set());
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

            <Dialog
                open={dialogue?.kind === 'delete'}
                onClose={() => setDialogue(null)}
                title={`Supprimer ${selectedOnPage} ligne${selectedOnPage > 1 ? 's' : ''} ?`}
                width={520}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setDialogue(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => void removeSelected()} disabled={busy}>
                            {busy ? 'Suppression…' : 'Supprimer'}
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    Ces lignes sont supprimées de <strong>{table?.name}</strong>, sur le serveur, immédiatement. DevEye
                    ne sait pas revenir en arrière — seule une sauvegarde du serveur le permettrait.
                </p>
            </Dialog>
        </motion.section>
    );
}

export default TableExplorer;
