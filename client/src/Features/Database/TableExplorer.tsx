import { useCallback, useEffect, useState } from 'react';
import type { DatabaseRows, DatabaseTable } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import { formatBytes, formatCount } from './format';
import styles from './style.module.css';

/** Lignes par page. Aligné sur le défaut du serveur. */
const PAGE = 50;

interface TableExplorerProps {
    databaseId: number;
}

/**
 * L'exploration manuelle des tables.
 *
 * **Rien ne part tant qu'on n'a pas cliqué.** Ouvrir la fiche d'une base
 * n'ouvre aucune connexion ; c'est « Charger les tables » qui va voir, et
 * sélectionner une table qui en lit le contenu. C'est le principe de toute la
 * feature, et c'est ici qu'il compte le plus : personne ne veut qu'un onglet
 * laissé ouvert interroge la production en boucle.
 *
 * Les valeurs arrivent déjà en chaînes (voir `databaseRowsSchema`) : un
 * `BIGINT` dépasse le nombre sûr de JavaScript, et une date n'a pas la même
 * forme chez les deux moteurs. On les affiche telles quelles.
 */
export function TableExplorer({ databaseId }: TableExplorerProps) {
    const [tables, setTables] = useState<DatabaseTable[] | null>(null);
    const [selected, setSelected] = useState<DatabaseTable | null>(null);
    const [rows, setRows] = useState<DatabaseRows | null>(null);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Changer de base referme tout : garder les tables d'une autre à l'écran
    // serait au mieux déroutant, au pire trompeur.
    useEffect(() => {
        setTables(null);
        setSelected(null);
        setRows(null);
        setOffset(0);
        setError(null);
    }, [databaseId]);

    const loadTables = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('database.tableList', { databaseId });
            setTables(res.tables);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de lire les tables.'));
        } finally {
            setBusy(false);
        }
    };

    const loadRows = useCallback(
        async (table: DatabaseTable, at: number) => {
            setBusy(true);
            setError(null);
            try {
                const res = await ws.send('database.tableRows', {
                    databaseId,
                    schema: table.schema,
                    table: table.name,
                    offset: at,
                    limit: PAGE
                });
                setRows(res.rows);
                setOffset(at);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de lire cette table.'));
            } finally {
                setBusy(false);
            }
        },
        [databaseId]
    );

    const open = (table: DatabaseTable) => {
        setSelected(table);
        void loadRows(table, 0);
    };

    const total = rows?.total ?? null;
    const hasPrev = offset > 0;
    const hasNext = total !== null && offset + PAGE < total;

    return (
        <section className={styles.panel}>
            <header className={styles.panelHead}>
                <h3 className={styles.panelTitle}>Tables</h3>
                <Button variant='secondary' icon='refresh' onClick={() => void loadTables()} disabled={busy}>
                    {tables === null ? 'Charger les tables' : 'Recharger'}
                </Button>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {tables === null && (
                <p className={styles.hint}>
                    Rien n’est chargé pour l’instant : la base n’est jointe qu’au moment où vous le demandez.
                </p>
            )}

            {tables?.length === 0 && <p className={styles.hint}>Cette base ne contient aucune table.</p>}

            {tables && tables.length > 0 && (
                <div className={styles.explorer}>
                    <ul className={styles.tableList}>
                        {tables.map((table) => (
                            <li key={`${table.schema}.${table.name}`}>
                                <button
                                    type='button'
                                    className={
                                        selected?.name === table.name && selected.schema === table.schema
                                            ? styles.tableItemOn
                                            : styles.tableItem
                                    }
                                    onClick={() => open(table)}
                                >
                                    <span className={styles.tableName}>{table.name}</span>
                                    <span className={styles.tableMeta}>
                                        {formatCount(table.rowCount)} l. · {formatBytes(table.sizeBytes)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>

                    <div className={styles.rowsPane}>
                        {!selected && <p className={styles.hint}>Choisissez une table pour en voir le contenu.</p>}

                        {selected && rows && (
                            <>
                                <div className={styles.rowsHead}>
                                    <span className={styles.tableName}>{selected.name}</span>
                                    <span className={styles.hint}>
                                        {total === null
                                            ? `${rows.rows.length} lignes`
                                            : `${offset + 1}–${Math.min(offset + PAGE, total)} sur ${formatCount(total)}`}
                                        {' · '}
                                        {rows.elapsedMs} ms
                                    </span>
                                    <div className={styles.actions}>
                                        <Button
                                            variant='secondary'
                                            onClick={() => void loadRows(selected, Math.max(0, offset - PAGE))}
                                            disabled={busy || !hasPrev}
                                        >
                                            Précédent
                                        </Button>
                                        <Button
                                            variant='secondary'
                                            onClick={() => void loadRows(selected, offset + PAGE)}
                                            disabled={busy || !hasNext}
                                        >
                                            Suivant
                                        </Button>
                                    </div>
                                </div>

                                {/* Le tableau défile dans sa propre boîte : une
                                    table à quarante colonnes ne doit pas faire
                                    défiler la page entière. */}
                                <div className={styles.rowsScroll}>
                                    <table className={styles.dataTable}>
                                        <thead>
                                            <tr>
                                                {rows.columns.map((column) => (
                                                    <th key={column}>{column}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.rows.map((row, i) => (
                                                // L'index comme clé : une page de
                                                // résultats n'a pas d'identité
                                                // stable, et rien ici n'est
                                                // réordonné ni inséré.
                                                <tr key={i}>
                                                    {row.map((cell, j) => (
                                                        <td key={j} className={cell === null ? styles.nullCell : ''}>
                                                            {cell === null ? 'NULL' : cell}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {rows.rows.length === 0 && <p className={styles.hint}>Aucune ligne à cet endroit.</p>}
                            </>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}

export default TableExplorer;
