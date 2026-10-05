import type { InvoicingLine } from '../contracts/domain';
import { formatMoney, formatVatRate, quantityToInput, unitLabel } from './format';
import styles from './style.module.css';

/**
 * Les lignes d'un document émis, en lecture. Un vrai `<table>` ici, et une
 * grille de champs dans l'éditeur : ce sont deux choses différentes. Ici c'est
 * de la donnée, qu'un lecteur d'écran doit pouvoir parcourir en colonnes ; là
 * c'est un formulaire, où « tableau, rangée 3, colonne 2, champ de saisie »
 * serait du bruit pur. À l'étroit, chaque rangée se replie en bloc, et la
 * légende de chaque case vient de son `data-label`.
 */
export interface LineTableProps {
    lines: readonly InvoicingLine[];
    currency: string;
    withVat: boolean;
}

export default function LineTable({ lines, currency, withVat }: LineTableProps) {
    return (
        <div className={styles.tableWrap}>
            <table className={styles.table}>
                <caption className={styles.visuallyHidden}>Le détail des prestations facturées</caption>
                <thead>
                    <tr>
                        <th scope='col'>Désignation</th>
                        <th scope='col'>Qté</th>
                        <th scope='col'>Prix unitaire</th>
                        {withVat && <th scope='col'>TVA</th>}
                        <th scope='col'>Total HT</th>
                    </tr>
                </thead>
                <tbody>
                    {lines.map((line) =>
                        line.kind === 'text' ? (
                            <tr key={line.id} className={styles.tableNote}>
                                <td colSpan={withVat ? 5 : 4}>{line.label}</td>
                            </tr>
                        ) : (
                            <tr key={line.id}>
                                <th scope='row'>
                                    {line.label}
                                    {line.description.length > 0 && (
                                        <span className={styles.tableDetail}>{line.description}</span>
                                    )}
                                </th>
                                <td data-label='Qté'>
                                    {quantityToInput(line.quantityMilli)} {unitLabel(line.unit, line.quantityMilli)}
                                </td>
                                <td data-label='Prix unitaire'>{formatMoney(line.unitPrice, currency)}</td>
                                {withVat && <td data-label='TVA'>{formatVatRate(line.vatRateBp)}</td>}
                                <td data-label='Total HT' className={styles.tableTotal}>
                                    {formatMoney(line.netCents, currency)}
                                </td>
                            </tr>
                        )
                    )}
                </tbody>
            </table>
        </div>
    );
}
