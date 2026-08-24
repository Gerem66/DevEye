import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type {
    DatabaseCombinator,
    DatabaseFilter,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from '@deveye/types';
import { Button, Checkbox, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { useRequestPopupWidth } from '@/stores/popupWidth';
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

/**
 * Le temps que la disposition met à se poser après un agrandissement.
 *
 * Calé sur `--transition-slow` (400 ms), qui referme la colonne des tables, plus
 * une marge : c'est le délai après lequel une mesure de largeur porte sur la
 * disposition finale et non sur une image intermédiaire.
 */
const SETTLE_MS = 450;

/** Deux références désignent-elles la même table ? Par son nom, pas son identité. */
function sameTable(a: DatabaseTable | null, b: DatabaseTable | null): boolean {
    return a !== null && b !== null && a.schema === b.schema && a.name === b.name;
}

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
    /** La table **choisie** — celle que la liste de gauche met en avant. */
    const [table, setTable] = useState<DatabaseTable | null>(null);
    /**
     * La table que `rows` et `structure` décrivent **réellement**.
     *
     * Distincte de la précédente le temps d'un chargement : le clic déplace la
     * sélection tout de suite, le contenu ne change qu'à l'arrivée des lignes.
     * Tout ce qui décrit le contenu affiché — son nom, sa fenêtre, sa clé
     * primaire — se lit donc ici, sans quoi l'écran annoncerait pendant une
     * demi-seconde une table dont il montre les lignes d'une autre.
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
    /** Les lignes cochées, par clé primaire — un indice ne survit pas au tri. */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** La ligne rejointe par une clé étrangère, auréolée quelques secondes. */
    const [highlight, setHighlight] = useState<string | null>(null);
    const [dialogue, setDialogue] = useState<Dialogue | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Le plein écran était-il déjà installé au rendu précédent ? */
    const wasExpanded = useRef(false);

    /**
     * La largeur que la popup doit prendre pour montrer la table en entier.
     *
     * Seulement en plein écran : c'est le mode où l'on vient regarder *une*
     * table, et la seule chose qui doive alors décider de la largeur de l'écran,
     * c'est elle. Hors de ce mode, la popup garde sa largeur de lecture.
     *
     * `null` = aucune demande, donc la popup revient à sa largeur commune. Le
     * store ne descend jamais sous 1240 px et écrête à la fenêtre : demander
     * large ne peut ni rétrécir la popup ni la faire déborder.
     */
    const [wantedWidth, setWantedWidth] = useState<number | null>(null);
    useRequestPopupWidth(expanded ? wantedWidth : null);

    /**
     * Mesurer ce qui manque, et le demander en une fois.
     *
     * La cible est **absolue** — largeur du tableau plus l'habillage — et non un
     * ajustement relatif : la popup s'élargit par une transition CSS, donc une
     * mesure prise en plein vol verrait une largeur intermédiaire et l'on
     * ajouterait deux fois le même manque.
     *
     * L'habillage se mesure contre le cadre de la popup, et c'est là qu'il faut
     * **attendre** : à l'entrée en plein écran, la colonne des tables est encore
     * ouverte pendant sa transition, et ses 240 px compteraient comme de
     * l'habillage. On demanderait alors une popup trop large, puis on la
     * rétrécirait — deux mouvements pour un geste. Une fois installé, en
     * revanche, plus rien ne bouge : changer de table mesure tout de suite.
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
            // Rendu hors d'une popup de feature (un test, un autre hôte) : on ne
            // demande rien plutôt que de deviner un habillage.
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

    // Changer de base referme tout : garder les tables d'une autre à l'écran
    // serait au mieux déroutant, au pire trompeur. Le plein écran retombe avec
    // le reste — il n'a plus de table à montrer.
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
                // Les trois d'un bloc : c'est ce qui fait qu'à aucun instant
                // l'écran ne montre les lignes d'une table sous le nom d'une
                // autre. Le remplacement est le seul moment où le contenu change.
                setRows(res.rows);
                setOffset(at);
                shownRef.current = target;
                setShown(target);
                if (res.structure) setStructure(res.structure);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de lire cette table.'));
                // Un échec **en changeant de table** ne doit pas laisser le
                // contenu de la précédente derrière le voile qui se lève : il
                // passerait pour celui de la nouvelle. Un échec de pagination,
                // lui, garde la page affichée — elle est toujours juste.
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
     * Ouvre une table : ses critères repartent de zéro, son contenu **reste**.
     *
     * Vider `rows` et `structure` ici démontait tout le bloc de droite le temps
     * de l'aller-retour : le panneau retombait à la hauteur d'un panneau vide,
     * puis se redéployait — un sursaut de la moitié de l'écran pour un clic dans
     * une liste. Les lignes précédentes tiennent donc la place jusqu'à ce que les
     * nouvelles arrivent, et le voile de chargement dit qu'elles ne sont plus
     * celles qu'on regarde.
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
        <motion.section
            layout
            transition={EXPAND_SPRING}
            className={expanded ? styles.panelExpanded : styles.panelGrow}
        >
            {/* En plein écran, tout ce qui parle de la base disparaît — y compris
                cet en-tête : on est venu regarder *une* table. */}
            {!expanded && (
                /*
                 * `layout` ici aussi, et pour la raison écrite plus bas : une
                 * animation de disposition redimensionne par une échelle, et une
                 * échelle déforme ce qu'elle contient. Cet en-tête ne le portait
                 * pas, il encaissait donc l'étirement vertical en entier —
                 * titre et boutons compris, ce qui est précisément ce qui se
                 * voyait. Le porter lui donne l'échelle inverse.
                 */
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

                        {/* La toute première lecture, la seule qui n'ait rien à
                            garder à l'écran : elle a droit à une attente en
                            clair, faute de contenu à voiler. */}
                        {table && !shown && busy && (
                            <p className={styles.loadingLine}>
                                <span className={`icon icon-spinner ${styles.spinning}`} aria-hidden='true' />
                                Lecture de {table.name}…
                            </p>
                        )}

                        {/*
                         * Un cadre autour de la table ouverte, et c'est tout son
                         * objet : sans lui, « Ajouter / Modifier / Supprimer »
                         * flottaient entre la liste des tables et le contenu, et
                         * rien ne disait qu'ils portaient sur la table
                         * sélectionnée plutôt que sur la base.
                         */}
                        {table && shown && rows && (
                            <motion.div layout transition={EXPAND_SPRING} className={styles.tablePanel}>
                                {/*
                                 * Le voile d'un chargement : il **couvre** le
                                 * contenu précédent au lieu de le remplacer. Rien
                                 * ne se démonte, donc rien ne se replie — la
                                 * hauteur du panneau ne bouge pas d'un pixel entre
                                 * deux tables, et le contenu suivant s'installe
                                 * d'un coup, sans passer par un écran vide.
                                 */}
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
