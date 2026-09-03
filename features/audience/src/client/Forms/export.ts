import type { AudienceSubmission } from '../../contracts/domain';

import { formatFieldValue } from '../format';

/**
 * Les retours chargés, en CSV. Point-virgule et BOM : c'est ce qu'Excel en
 * français attend, et un fichier séparé par des virgules s'y ouvre en une seule
 * colonne.
 *
 * L'export porte ce que le tableau a chargé, et rien de plus : le dire est plus
 * honnête que de laisser croire à un export complet quand la liste est paginée.
 */
export function toCsv(columns: readonly string[], submissions: readonly AudienceSubmission[]): string {
    const head = ['Reçu le', ...columns];
    const rows = submissions.map((submission) => [
        new Date(submission.at * 1000).toISOString(),
        ...columns.map((column) => formatFieldValue(submission.fields[column] ?? null))
    ]);
    // Le BOM en tête : sans lui, Excel lit le fichier en latin-1 et les accents
    // arrivent en charabia.
    return `\ufeff${[head, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')}`;
}

/**
 * Une cellule échappée. Les guillemets doublés et le champ entier entre
 * guillemets dès qu'il porte un séparateur, un saut de ligne ou un guillemet.
 */
function cell(value: string): string {
    return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
