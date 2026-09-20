import { useEffect, useMemo, useState } from 'react';
import { Button, copyText, Dialog } from 'deveye-sdk-client';
import type { DatabaseRows } from '../contracts/domain';
import { formatCount } from './format';
import styles from './style.module.css';

const COPIED_MS = 1600;

interface ResultTableProps {
    rows: DatabaseRows;
    /** N'afficher que les premières lignes (un aperçu). */
    limit?: number;
    /** Absent, les en-têtes restent du texte : un aperçu ne se trie pas. */
    sort?: { column: string; direction: 'asc' | 'desc' } | null;
    onSort?: (column: string) => void;
    /** Occuper toute la hauteur disponible. */
    fill?: boolean;
}

/**
 * Un jeu de résultats, tel quel, pour l'aperçu comme pour la vue complète.
 * `NULL` reste distinct de la chaîne vide.
 */
export function ResultTable({ rows, limit, sort, onSort, fill }: ResultTableProps) {
    const shown = limit === undefined ? rows.rows : rows.rows.slice(0, limit);

    return (
        <div className={fill ? styles.rowsScrollFill : styles.rowsScroll}>
            <table className={styles.dataTable}>
                <thead>
                    <tr>
                        {rows.columns.map((column) => (
                            <th key={column}>
                                {onSort ? (
                                    <button
                                        type='button'
                                        className={styles.sortButton}
                                        title='Trier sur cette colonne'
                                        onClick={() => onSort(column)}
                                    >
                                        {column}
                                        {sort?.column === column && (
                                            <span aria-hidden='true'>{sort.direction === 'asc' ? ' ↑' : ' ↓'}</span>
                                        )}
                                    </button>
                                ) : (
                                    column
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {shown.map((row, r) => (
                        <tr key={r}>
                            {row.map((cell, c) => (
                                <td key={c} className={cell === null ? styles.nullCell : ''}>
                                    {cell === null ? 'NULL' : cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

interface ResultDialogProps {
    open: boolean;
    /** L'instruction, telle qu'elle a été tapée. */
    sql: string;
    rows: DatabaseRows | null;
    onClose: () => void;
}

/**
 * Un jeu de résultats en grand : toute la hauteur, un tri par colonne, une
 * copie. Le tri est local : rejouer l'instruction avec un `ORDER BY` serait faux
 * (un `SHOW` ne se trie pas) et l'exécuterait deux fois.
 */
export function ResultDialog({ open, sql, rows, onClose }: ResultDialogProps) {
    const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!open) setSort(null);
    }, [open]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    // Comparaison numérique quand les deux valeurs sont des nombres (sinon 10
    // passerait avant 9), textuelle sinon ; `NULL` toujours en fin.
    const sorted = useMemo(() => {
        if (!rows || !sort) return rows;
        const at = rows.columns.indexOf(sort.column);
        if (at === -1) return rows;
        const sign = sort.direction === 'asc' ? 1 : -1;
        const list = [...rows.rows].sort((a, b) => {
            const x = a[at];
            const y = b[at];
            if (x === null && y === null) return 0;
            if (x === null) return 1;
            if (y === null) return -1;
            const nx = Number(x);
            const ny = Number(y);
            const numeric = x.trim() !== '' && y.trim() !== '' && Number.isFinite(nx) && Number.isFinite(ny);
            return sign * (numeric ? nx - ny : x.localeCompare(y, 'fr'));
        });
        return { ...rows, rows: list };
    }, [rows, sort]);

    const copy = async () => {
        if (!sorted) return;
        // Tabulations : ce qu'un tableur attend d'un collage.
        const text = [
            sorted.columns.join('\t'),
            ...sorted.rows.map((row) => row.map((cell) => cell ?? 'NULL').join('\t'))
        ].join('\n');
        if (await copyText(text)) setCopied(true);
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Résultat'
            description={
                sorted
                    ? `${formatCount(sorted.rows.length)} ligne${sorted.rows.length > 1 ? 's' : ''} · ${sorted.columns.length} colonne${sorted.columns.length > 1 ? 's' : ''} · ${sorted.elapsedMs} ms`
                    : undefined
            }
            width={1100}
            tall
            footer={
                <>
                    <Button
                        variant='secondary'
                        icon={copied ? 'success' : 'copy'}
                        className={styles.footerLead}
                        onClick={() => void copy()}
                        disabled={!sorted}
                    >
                        {copied ? 'Copié' : 'Copier'}
                    </Button>
                    <Button onClick={onClose}>Fermer</Button>
                </>
            }
        >
            <div className={styles.resultBody}>
                <pre className={styles.terminalSql}>{sql}</pre>
                {sorted && (
                    <ResultTable
                        rows={sorted}
                        fill
                        sort={sort}
                        onSort={(column) =>
                            setSort((current) =>
                                current?.column === column && current.direction === 'asc'
                                    ? { column, direction: 'desc' }
                                    : { column, direction: 'asc' }
                            )
                        }
                    />
                )}
            </div>
        </Dialog>
    );
}

export default ResultTable;
