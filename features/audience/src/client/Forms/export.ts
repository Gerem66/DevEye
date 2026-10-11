import { toCsv } from '@deveye/types/sdk';

import type { AudienceSubmission } from '../../contracts/domain';

import { formatFieldValue } from '../format';

/**
 * Les retours chargés, en CSV. Point-virgule et BOM : c'est ce qu'Excel en
 * français attend, et un fichier séparé par des virgules s'y ouvre en une seule
 * colonne. Les cellules viennent d'un formulaire public : `toCsv` neutralise ce
 * qu'un tableur prendrait pour une formule.
 *
 * L'export porte ce que le tableau a chargé, et rien de plus : le dire est plus
 * honnête que de laisser croire à un export complet quand la liste est paginée.
 */
export function submissionsCsv(columns: readonly string[], submissions: readonly AudienceSubmission[]): string {
    const head = ['Reçu le', ...columns];
    const rows = submissions.map((submission) => [
        new Date(submission.at * 1000).toISOString(),
        ...columns.map((column) => formatFieldValue(submission.fields[column] ?? null))
    ]);
    return toCsv([head, ...rows]);
}

/** Propose le fichier au navigateur, puis rend l'URL temporaire. */
export function downloadCsv(name: string, csv: string): void {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}
