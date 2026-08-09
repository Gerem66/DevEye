import type { DatabaseStructure } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import styles from './style.module.css';

interface StructureDialogProps {
    open: boolean;
    structure: DatabaseStructure;
    onClose: () => void;
    /** Ouvrir la table visée par une contrainte. */
    onOpenTable: (schema: string, table: string) => void;
}

/**
 * La structure d'une table : ce qu'elle contient, et ce à quoi elle est reliée.
 *
 * Trois blocs dans l'ordre où l'on s'y intéresse — les colonnes, ce qui pointe
 * ailleurs, ce qui accélère les recherches. Les clés étrangères y sont
 * cliquables : lire qu'une colonne pointe `clients.id` donne aussitôt envie
 * d'aller voir `clients`, et l'y emmener est le seul geste utile qu'on puisse
 * offrir depuis cet écran.
 */
export function StructureDialog({ open, structure, onClose, onOpenTable }: StructureDialogProps) {
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
