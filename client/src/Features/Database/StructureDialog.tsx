import { useEffect, useState } from 'react';
import type { DatabaseStructure } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import styles from './style.module.css';

/** Combien de temps la confirmation « copié » reste affichée. */
const COPIED_MS = 1600;

interface StructureDialogProps {
    open: boolean;
    structure: DatabaseStructure;
    onClose: () => void;
    /** Ouvrir la table visée par une contrainte. */
    onOpenTable: (schema: string, table: string) => void;
}

/**
 * La structure d'une table, en texte aligné.
 *
 * Ce qu'on colle dans un ticket, un message, un fichier de notes — d'où le choix
 * du texte brut plutôt que du CSV ou du JSON : la question qu'on pose en
 * partageant une structure est « à quoi ressemble cette table », et un tableau
 * aligné y répond sans outil pour le relire. Les colonnes sont calées sur la
 * plus longue de chaque champ, ce qui reste lisible dans n'importe quelle police
 * à chasse fixe.
 */
export function structureAsText(structure: DatabaseStructure): string {
    const lines: string[] = [];
    lines.push(`Table ${structure.schema}.${structure.table}`);
    lines.push(
        structure.primaryKey.length > 0 ? `Clé primaire : ${structure.primaryKey.join(', ')}` : 'Pas de clé primaire'
    );
    lines.push('');

    const width = (pick: (c: DatabaseStructure['columns'][number]) => string) =>
        structure.columns.reduce((max, column) => Math.max(max, pick(column).length), 0);
    const nameWidth = width((c) => c.name);
    const typeWidth = width((c) => c.type);

    lines.push('Colonnes');
    for (const column of structure.columns) {
        const flags = [
            column.nullable ? 'NULL' : 'NOT NULL',
            ...(column.primaryKey ? ['PK'] : []),
            ...(column.generated ? ['auto'] : []),
            ...(column.default === null ? [] : [`défaut ${column.default}`])
        ];
        const comment = column.comment === '' ? '' : `  -- ${column.comment}`;
        lines.push(
            `  ${column.name.padEnd(nameWidth)}  ${column.type.padEnd(typeWidth)}  ${flags.join(', ')}${comment}`
        );
    }

    if (structure.foreignKeys.length > 0) {
        lines.push('');
        lines.push('Clés étrangères');
        for (const fk of structure.foreignKeys) {
            lines.push(`  ${fk.name} : (${fk.columns.join(', ')}) → ${fk.refTable}(${fk.refColumns.join(', ')})`);
        }
    }

    if (structure.indexes.length > 0) {
        lines.push('');
        lines.push('Index');
        for (const index of structure.indexes) {
            lines.push(`  ${index.name} (${index.columns.join(', ')})${index.unique ? ' unique' : ''}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

/**
 * La structure d'une table : ce qu'elle contient, et ce à quoi elle est reliée.
 *
 * Trois blocs dans l'ordre où l'on s'y intéresse — les colonnes, ce qui pointe
 * ailleurs, ce qui accélère les recherches. Les clés étrangères y sont
 * cliquables : lire qu'une colonne pointe `clients.id` donne aussitôt envie
 * d'aller voir `clients`, et l'y emmener est le seul geste utile qu'on puisse
 * offrir depuis cet écran.
 *
 * Le second est **la copie**. Décrire une table dans un message se faisait
 * jusqu'ici en la recopiant colonne par colonne depuis cet écran ; un bouton
 * dans le coin en fait un geste de deux secondes, mis en forme.
 */
export function StructureDialog({ open, structure, onClose, onOpenTable }: StructureDialogProps) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(structureAsText(structure));
            setCopied(true);
        } catch {
            /* `navigator.clipboard` n'existe qu'en contexte sécurisé */
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Structure de ${structure.table}`}
            description={
                structure.primaryKey.length > 0
                    ? `Clé primaire : ${structure.primaryKey.join(', ')}`
                    : 'Cette table n’a pas de clé primaire : elle se lit, mais ne se modifie pas depuis DevEye.'
            }
            width={820}
            headerAction={
                /* Dans le coin de la popup, que le Dialog possède : posé à côté
                   d'un titre de section, il aurait fallu deviner s'il ne copiait
                   que ce bloc. Ici, il copie la fiche. */
                <button
                    type='button'
                    className={styles.infoButton}
                    title='Copier la structure mise en forme'
                    aria-label='Copier la structure'
                    onClick={() => void copy()}
                >
                    <span className={`icon icon-${copied ? 'success' : 'copy'}`} />
                </button>
            }
            footer={<Button onClick={onClose}>Fermer</Button>}
        >
            <div className={styles.form}>
                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Colonnes</span>
                    <div className={styles.rowsScroll}>
                        <table className={styles.dataTable}>
                            <thead>
                                <tr>
                                    <th>Colonne</th>
                                    <th>Type</th>
                                    <th>Nul</th>
                                    <th>Défaut</th>
                                    <th>Clé</th>
                                    <th>Commentaire</th>
                                </tr>
                            </thead>
                            <tbody>
                                {structure.columns.map((column) => (
                                    <tr key={column.name}>
                                        <td>{column.name}</td>
                                        <td>{column.type}</td>
                                        <td className={column.nullable ? '' : styles.nullCell}>
                                            {column.nullable ? 'oui' : 'non'}
                                        </td>
                                        <td className={column.default === null ? styles.nullCell : ''}>
                                            {column.default ?? '—'}
                                        </td>
                                        <td>
                                            {column.primaryKey && <span className={styles.tag}>primaire</span>}
                                            {column.generated && <span className={styles.tag}>auto</span>}
                                        </td>
                                        <td>{column.comment}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Clés étrangères</span>
                    {structure.foreignKeys.length === 0 ? (
                        <p className={styles.hint}>Aucune contrainte : cette table ne pointe aucune autre.</p>
                    ) : (
                        <ul className={styles.constraintList}>
                            {structure.foreignKeys.map((fk) => (
                                <li key={fk.name} className={styles.constraint}>
                                    <span className={styles.constraintBody}>
                                        <code>{fk.columns.join(', ')}</code> pointe{' '}
                                        <code>
                                            {fk.refTable}.{fk.refColumns.join(', ')}
                                        </code>
                                        <span className={styles.hint}>{fk.name}</span>
                                    </span>
                                    <Button variant='secondary' onClick={() => onOpenTable(fk.refSchema, fk.refTable)}>
                                        Ouvrir {fk.refTable}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Index</span>
                    {structure.indexes.length === 0 ? (
                        <p className={styles.hint}>Aucun index en dehors de la clé primaire.</p>
                    ) : (
                        <ul className={styles.constraintList}>
                            {structure.indexes.map((index) => (
                                <li key={index.name} className={styles.constraint}>
                                    <span className={styles.constraintBody}>
                                        <code>{index.columns.join(', ')}</code>
                                        <span className={styles.hint}>{index.name}</span>
                                    </span>
                                    {index.unique && <span className={styles.tag}>unique</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </Dialog>
    );
}

export default StructureDialog;
