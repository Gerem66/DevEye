import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type {
    DatabaseCombinator,
    DatabaseFilter,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from 'deveye-types';
import { Button, Checkbox, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import { ExportDialog } from './ExportDialog';
import { Pagination } from './Pagination';
import { RowDialog } from './RowDialog';
import { SearchDialog } from './SearchDialog';
import { StructureDialog } from './StructureDialog';
import { TerminalDialog } from './TerminalDialog';
import { compareTables, FILTER_OPERATOR_LABELS, formatBytes, formatCount, OPERATOR_NEEDS_VALUE } from './format';
import { rowKey, rowKeyCells } from './rowKey';
import styles from './style.module.css';

/** Lignes par page. Aligné sur le défaut du serveur. */
const PAGE = 50;
/** Durée du halo d'une ligne qu'on vient de rejoindre. */
const HIGHLIGHT_MS = 3500;

/**
 * Le ressort de l'agrandissement.
 *
 * Assez ferme pour que le geste paraisse immédiat, assez amorti pour qu'il ne
 * rebondisse pas : un panneau qui dépasse sa taille puis revient donne
 * l'impression d'un accident, pas d'un choix.
 */
const EXPAND_SPRING = { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 } as const;

interface TableExplorerProps {
    databaseId: number;
    databaseName: string;
    /** Charger l'inventaire des tables dès l'affichage (réglage de la base). */
    autoLoad: boolean;
    /** La table ouverte occupe toute la popup. Piloté par l'appelant. */
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

/** Quelle popup est ouverte. Une seule à la fois, elles se recouvriraient. */
type Dialogue =
    | { kind: 'row'; row: { columns: string[]; values: (string | null)[] } | null }
    | { kind: 'structure' }
    | { kind: 'search' }
    | { kind: 'terminal' }
    | { kind: 'export' }
    | { kind: 'delete' };

/**
 * L'exploration et l'administration des tables.
 *
 * **Rien ne part tant qu'on n'a pas cliqué** — sauf si la base est réglée pour
 * charger ses tables à l'ouverture, ce qui est éteint par défaut. C'est le
 * principe de toute la feature, et c'est ici qu'il compte le plus : personne ne
 * veut qu'un onglet laissé ouvert interroge la production en boucle.
 *
 * ## Ce qui tient l'écran
 *
 * Une liste de tables à gauche, la table ouverte à droite, et une barre d'outils
 * qui rassemble tout ce qu'on peut lui faire. Les gestes destructeurs y sont
 * séparés du reste, et deux d'entre eux — modifier, supprimer — n'existent pas
 * du tout sur une table sans clé primaire : sans clé, aucune condition ne
 * désigne *une* ligne, et le serveur refuserait de toute façon.
 *
 * ## Les valeurs restent des chaînes
 *
 * Elles arrivent déjà ainsi (voir `databaseRowsSchema`) : un `BIGINT` dépasse le
 * nombre sûr de JavaScript et une date n'a pas la même forme chez les deux
 * moteurs. On les affiche telles quelles, et on les renvoie telles quelles.
 */
export function TableExplorer({ databaseId, databaseName, autoLoad, expanded, onExpandedChange }: TableExplorerProps) {
    const [tables, setTables] = useState<DatabaseTable[] | null>(null);
    const [table, setTable] = useState<DatabaseTable | null>(null);
    const [structure, setStructure] = useState<DatabaseStructure | null>(null);
    const [rows, setRows] = useState<DatabaseRows | null>(null);
    const [offset, setOffset] = useState(0);
    const [filters, setFilters] = useState<DatabaseFilter[]>([]);
    const [combinator, setCombinator] = useState<DatabaseCombinator>('and');
    const [sort, setSort] = useState<DatabaseSort | null>(null);
    /** Les lignes cochées, par clé primaire — un indice ne survit pas au tri. */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** La ligne rejointe par une clé étrangère, auréolée quelques secondes. */
    const [highlight, setHighlight] = useState<string | null>(null);
    const [dialogue, setDialogue] = useState<Dialogue | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Changer de base referme tout : garder les tables d'une autre à l'écran
    // serait au mieux déroutant, au pire trompeur. Le plein écran retombe avec
    // le reste — il n'a plus de table à montrer.
    useEffect(() => {
        setTables(null);
        setTable(null);
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
            const res = await ws.send('database.tableList', { databaseId });
            // Rangées une fois pour toutes, ici : la liste de gauche, le
            // sélecteur de l'export et le suivi d'une clé étrangère lisent tous
            // celle-ci, et aucun n'a de raison de les voir dans un autre ordre.
            setTables([...res.tables].sort(compareTables));
        } catch (e) {
            setError(humanizeError(e, 'Impossible de lire les tables.'));
        } finally {
            setBusy(false);
        }
    }, [databaseId]);

    // Le seul endroit de la feature où une connexion part sans clic — et
    // seulement si la base le demande explicitement.
    useEffect(() => {
        if (autoLoad) void loadTables();
    }, [autoLoad, loadTables]);

    /**
     * Charge une page.
     *
     * `withStructure` ne sert qu'à la première lecture d'une table : structure et
     * première page arrivent alors dans la **même session**, ce qui compte quand
     * chaque connexion rouvre un tunnel SSH.
     */
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
                const res = await ws.send('database.tableRows', {
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
                setRows(res.rows);
                setOffset(at);
                if (res.structure) setStructure(res.structure);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de lire cette table.'));
            } finally {
                setBusy(false);
            }
        },
        [databaseId, filters, combinator, sort]
    );

    /** Ouvre une table : remet tout à zéro, puis lit structure et première page. */
    const open = useCallback(
        (target: DatabaseTable, nextFilters: DatabaseFilter[] = []) => {
            setTable(target);
            setStructure(null);
            setRows(null);
            setSelected(new Set());
            setFilters(nextFilters);
            setCombinator('and');
            setSort(null);
            void loadRows(target, 0, { filters: nextFilters, combinator: 'and', sort: null, withStructure: true });
        },
        [loadRows]
    );

    /**
     * Suivre une clé étrangère.
     *
     * La table visée s'ouvre **filtrée sur la valeur pointée**, et la ligne
     * trouvée s'auréole quelques secondes. Filtrer plutôt que calculer la page
     * où se trouve la ligne : ce calcul supposerait un ordre stable et une clé
     * d'une seule colonne, deux hypothèses que rien ne garantit. Le critère
     * reste visible et se retire d'un clic — on voit donc *pourquoi* on ne voit
     * qu'une ligne.
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
    /**
     * Combien de pages, en tout.
     *
     * `total` peut manquer — un moteur ne sait pas toujours compter sans coût.
     * On retombe alors sur ce qu'on a sous les yeux : une page pleine en suppose
     * une suivante, une page entamée est la dernière. C'est faux d'une page au
     * pire, et c'est ce qui permet de garder « Suivant » utilisable partout.
     */
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
            await ws.send('database.rowDelete', {
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

    /** La ligne unique cochée, quand il n'y en a qu'une — sinon `null`. */
    const singleSelectedRow = () => {
        if (!rows || selected.size !== 1) return null;
        const found = rows.rows.find((row) => {
            const key = rowKey(structure, rows.columns, row);
            return key !== null && selected.has(key);
        });
        return found ? { columns: rows.columns, values: found } : null;
    };

    return (
        /*
         * `layout` : l'agrandissement n'est pas un changement de classe qu'on
         * subit, c'est un mouvement qu'on suit. framer-motion mesure la boîte
         * avant et après, et anime l'écart — d'où un panneau qui *monte* vers sa
         * pleine taille au lieu d'apparaître dedans.
         */
        <motion.section layout transition={EXPAND_SPRING} className={expanded ? styles.panelExpanded : styles.panel}>
            {/* En plein écran, tout ce qui parle de la base disparaît — y compris
                cet en-tête : on est venu regarder *une* table. */}
            {!expanded && (
                <header className={styles.panelHead}>
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
                </header>
            )}

            {error && <p className={styles.error}>{error}</p>}

            {tables === null && (
                <p className={styles.hint}>
                    Rien n’est chargé pour l’instant : la base n’est jointe qu’au moment où vous le demandez. Le
                    chargement à l’ouverture se règle dans « Modifier ».
                </p>
            )}

            {tables?.length === 0 && <p className={styles.hint}>Cette base ne contient aucune table.</p>}

            {tables && tables.length > 0 && (
                /*
                 * `layout` aussi ici, et sur le cadre de la table : une animation
                 * de disposition redimensionne par une échelle, et une échelle
                 * déforme tout ce qui est dedans. Un enfant qui porte `layout` à
                 * son tour reçoit l'échelle inverse — c'est ce qui garde le texte
                 * et les bordures nets pendant tout le mouvement, au lieu d'un
                 * demi-seconde de contenu étiré.
                 */
                <motion.div
                    layout
                    transition={EXPAND_SPRING}
                    className={expanded ? styles.explorerExpanded : styles.explorer}
                >
                    {/*
                     * La liste tient dans une boîte qui, elle, s'étire à la
                     * hauteur de la ligne : c'est la seule façon d'obtenir une
                     * colonne aussi haute que sa voisine sans lui imposer une
                     * hauteur en dur — trop courte, elle laissait un vide sous
                     * elle ; sans plafond, elle repoussait la carte entière.
                     */}
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

                        {/*
                         * Un cadre autour de la table ouverte, et c'est tout son
                         * objet : sans lui, « Ajouter / Modifier / Supprimer »
                         * flottaient entre la liste des tables et le contenu, et
                         * rien ne disait qu'ils portaient sur la table
                         * sélectionnée plutôt que sur la base.
                         */}
                        {table && rows && (
                            <motion.div layout transition={EXPAND_SPRING} className={styles.tablePanel}>
                                <div className={styles.rowsHead}>
                                    <span className={styles.tableName}>
                                        {expanded ? `${databaseName} · ${table.name}` : table.name}
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
                                    {/* Le seul bouton qui survit au plein écran :
                                        c'est lui qui en sort. */}
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

                                {/* Le tableau défile dans sa propre boîte : une
                                    table à quarante colonnes ne doit pas faire
                                    défiler la page entière. En plein écran, cette
                                    boîte prend toute la hauteur restante — c'est
                                    tout l'intérêt d'y être passé. */}
                                <div className={expanded ? styles.rowsScrollFill : styles.rowsScroll}>
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
