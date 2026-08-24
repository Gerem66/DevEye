import { useEffect, useMemo, useState } from 'react';
import type { DatabaseRows } from '@deveye/types';
import { Button, Dialog } from '@/Components';
import { formatCount } from './format';
import styles from './style.module.css';

/** Combien de temps la confirmation « copié » reste affichée. */
const COPIED_MS = 1600;

interface ResultTableProps {
    rows: DatabaseRows;
    /** N'afficher que les premières lignes — un aperçu. */
    limit?: number;
    /**
     * Trier sur une colonne au clic de son en-tête.
     *
     * Absent, les en-têtes restent du texte : un aperçu ne se trie pas, il se
     * regarde.
     */
    sort?: { column: string; direction: 'asc' | 'desc' } | null;
    onSort?: (column: string) => void;
    /** Occuper toute la hauteur disponible plutôt que le gabarit par défaut. */
    fill?: boolean;
}

/**
 * Un jeu de résultats, tel quel.
 *
 * Le **seul** rendu de tableau de la feature qui ne soit pas celui de
 * l'explorateur : le terminal l'utilisait autrefois par recopie, les deux ont
 * divergé, et l'un des deux a fini par ne plus savoir dire `NULL`. Il est ici
 * une fois, et sert l'aperçu comme la vue complète — ce qui garantit qu'une
 * ligne vue en petit est la même que celle vue en grand.
 *
 * `NULL` reste distinct de la chaîne vide, comme partout ailleurs : les
 * confondre à l'affichage ferait douter de ce qu'il y a réellement en base.
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
    /** Ce qui a produit ces lignes — l'instruction, telle qu'elle a été tapée. */
    sql: string;
    rows: DatabaseRows | null;
    onClose: () => void;
}

/**
 * Un jeu de résultats en grand, et de quoi s'en servir.
 *
 * L'historique du terminal n'en montre qu'un aperçu : une requête qui rend
 * quatre cents lignes rendait la conversation illisible et repoussait l'invite
 * hors de l'écran, alors que ce qu'on veut d'un résultat passé tient en une
 * ligne — « combien, et à quoi ça ressemblait ». Le reste se regarde ici, dans un
 * écran fait pour ça : toute la hauteur, un tri par colonne, et une copie.
 *
 * Le **tri est local**. Rejouer l'instruction avec un `ORDER BY` serait faux : le
 * texte n'est pas forcément triable (un `SHOW`, un `EXPLAIN`), et rejouer une
 * requête pour la regarder autrement la ferait s'exécuter deux fois sur un
 * serveur de production. On trie donc ce qu'on a déjà.
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

    /**
     * Les lignes rangées.
     *
     * Comparaison numérique quand les deux valeurs sont des nombres, textuelle
     * sinon : trier des identifiants en chaînes mettrait 10 avant 9, ce qui est
     * exactement le cas où l'on trie. `NULL` va toujours en fin, dans les deux
     * sens — c'est une absence, pas une valeur extrême.
     */
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
        // Séparé par des tabulations : c'est ce qu'un tableur attend d'un
        // collage, et ce qui se relit le mieux dans un message.
        const text = [
            sorted.columns.join('\t'),
            ...sorted.rows.map((row) => row.map((cell) => cell ?? 'NULL').join('\t'))
        ].join('\n');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
        } catch {
            /* `navigator.clipboard` n'existe qu'en contexte sécurisé */
        }
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
