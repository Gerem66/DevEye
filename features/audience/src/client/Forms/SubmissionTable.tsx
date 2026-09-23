import { useMemo, useState } from 'react';
import { Button, TextInput } from 'deveye-sdk-client';
import type { AudienceSubmission } from '../../contracts/domain';

import { formatCount, formatDateTime, formatFieldValue } from '../format';
import styles from '../style.module.css';

interface SubmissionTableProps {
    submissions: AudienceSubmission[];
    /** `null` = tout est chargé ; sinon il reste une page à demander. */
    nextCursor: string | null;
    loadingMore: boolean;
    onLoadMore: () => void;
    onOpen: (submission: AudienceSubmission) => void;
}

/**
 * Les retours en tableau. Écrit à la main : le SDK n'offre aucun composant de
 * tableau, et un formulaire libre n'a de toute façon pas de colonnes connues
 * d'avance.
 *
 * Les colonnes sont l'union des questions des lignes **chargées**, dans l'ordre
 * où elles apparaissent : un formulaire dont on a changé les questions montre
 * les deux jeux, ce qui est la vérité de ce qu'il a reçu.
 *
 * Le tri et la recherche portent eux aussi sur les lignes chargées, et non sur
 * tout le formulaire : la charge utile est chiffrée au repos, la base n'a rien
 * à quoi appliquer un `ORDER BY` ni un `LIKE`. La phrase sous le tableau le dit
 * plutôt que de laisser croire à un tri complet.
 */
export function SubmissionTable({ submissions, nextCursor, loadingMore, onLoadMore, onOpen }: SubmissionTableProps) {
    /** `column: null` = la date de réception, la seule colonne qui n'est pas une question. */
    const [sort, setSort] = useState<{ column: string | null; asc: boolean }>({ column: null, asc: false });
    const [query, setQuery] = useState('');

    const columns = useMemo(() => {
        const seen: string[] = [];
        for (const submission of submissions) {
            for (const name of Object.keys(submission.fields)) if (!seen.includes(name)) seen.push(name);
        }
        return seen;
    }, [submissions]);

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = needle
            ? submissions.filter((submission) =>
                  Object.values(submission.fields).some((value) =>
                      formatFieldValue(value).toLowerCase().includes(needle)
                  )
              )
            : submissions;

        const direction = sort.asc ? 1 : -1;
        return [...filtered].sort((a, b) => {
            if (sort.column === null) return (a.at - b.at) * direction;
            const column = sort.column;
            const left = formatFieldValue(a.fields[column] ?? null);
            const right = formatFieldValue(b.fields[column] ?? null);
            // Comparaison naturelle : « 10 » passe après « 9 » sur une note, et un
            // accent ne renvoie pas un nom en fin de liste.
            return left.localeCompare(right, 'fr', { numeric: true, sensitivity: 'base' }) * direction;
        });
    }, [submissions, query, sort]);

    const toggle = (column: string | null) =>
        setSort((prev) => (prev.column === column ? { column, asc: !prev.asc } : { column, asc: true }));

    const header = (column: string | null, label: string) => (
        <th
            key={column ?? label}
            scope='col'
            // La flèche est décorative : sans `aria-sort`, rien ne dit à un lecteur
            // d'écran quelle colonne trie ni dans quel sens.
            aria-sort={sort.column !== column ? 'none' : sort.asc ? 'ascending' : 'descending'}
        >
            <button type='button' className={styles.tableSort} onClick={() => toggle(column)}>
                {label}
                <span className={styles.tableArrow} aria-hidden='true'>
                    {sort.column === column ? (sort.asc ? '↑' : '↓') : ''}
                </span>
            </button>
        </th>
    );

    return (
        <>
            <div className={styles.tableBar}>
                <TextInput
                    type='search'
                    value={query}
                    placeholder='Rechercher dans les retours chargés'
                    aria-label='Rechercher'
                    onChange={(e) => setQuery(e.target.value)}
                />
                <span className={styles.tableCount}>
                    {formatCount(rows.length)} sur {formatCount(submissions.length)} chargés
                </span>
            </div>

            {rows.length === 0 ? (
                <p className={styles.empty}>Aucun retour ne correspond à cette recherche.</p>
            ) : (
                // Un formulaire large déborde : c'est le conteneur qui défile, jamais
                // la page, sans quoi tout l'écran glisserait sous le pointeur.
                <div className={styles.tableScroll}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                {header(null, 'Reçu le')}
                                {columns.map((column) => header(column, column))}
                                <th scope='col' className={styles.tableRawHead}>
                                    Détail
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((submission) => (
                                <tr key={submission.id}>
                                    <td className={styles.tableWhen}>{formatDateTime(submission.at)}</td>
                                    {columns.map((column) => (
                                        <td key={column} title={formatFieldValue(submission.fields[column] ?? null)}>
                                            {formatFieldValue(submission.fields[column] ?? null)}
                                        </td>
                                    ))}
                                    <td>
                                        <Button
                                            variant='ghost'
                                            onClick={() => onOpen(submission)}
                                            title='Voir le retour tel qu’il est arrivé'
                                            aria-label='Voir le détail de ce retour'
                                        >
                                            <span className='icon icon-details' aria-hidden='true' />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className={styles.tableFoot}>
                {nextCursor !== null && (
                    <Button variant='secondary' disabled={loadingMore} onClick={onLoadMore}>
                        {loadingMore ? 'Chargement…' : 'Charger 100 de plus'}
                    </Button>
                )}
                <span className={styles.tableNote}>
                    Le tri et la recherche portent sur les retours déjà chargés : leur contenu est chiffré, la base ne
                    peut ni les trier ni les fouiller.
                </span>
            </div>
        </>
    );
}

export default SubmissionTable;
