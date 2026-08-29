import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, humanizeError, TextInput } from 'deveye-sdk-client';
import type { DatabaseCell, DatabaseColumn, DatabaseStructure } from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

interface RowDialogProps {
    open: boolean;
    databaseId: number;
    structure: DatabaseStructure;
    /** La ligne modifiée, valeurs dans l'ordre de `columns` ; `null` = ajout. */
    row: { columns: string[]; values: (string | null)[] } | null;
    onClose: () => void;
    onSaved: () => void;
}

interface Field {
    value: string;
    isNull: boolean;
    /** Laissée au moteur : le champ n'est pas envoyé du tout. */
    auto: boolean;
}

/** Mérite une zone multiligne. */
function isLongText(column: DatabaseColumn): boolean {
    return /text|json|blob|bytea|xml/i.test(column.type);
}

/**
 * Ajouter ou modifier une ligne : un champ par colonne, dans l'ordre de la
 * table. `NULL` a sa case, distincte de la chaîne vide. Une colonne que le
 * moteur remplit reste à sa place, fermée, et s'ouvre si l'on veut imposer une
 * valeur. À la modification, la clé primaire reste hors du formulaire.
 */
export function RowDialog({ open, databaseId, structure, row, onClose, onSaved }: RowDialogProps) {
    const [fields, setFields] = useState<Record<string, Field>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const editing = row !== null;

    useEffect(() => {
        if (!open) return;
        setError(null);
        const next: Record<string, Field> = {};
        for (const column of structure.columns) {
            const index = row ? row.columns.indexOf(column.name) : -1;
            const current = index === -1 ? undefined : row?.values[index];
            const auto = !editing && column.generated;
            next[column.name] = {
                value: current ?? '',
                // À l'ajout, une colonne nullable part sur `NULL`, comme le
                // ferait le moteur.
                isNull: !auto && (current === null || (current === undefined && column.nullable)),
                auto
            };
        }
        setFields(next);
    }, [open, structure, row, editing]);

    const editable = structure.columns.filter((c) => !editing || !structure.primaryKey.includes(c.name));

    /** Une colonne laissée au moteur ne part pas. */
    const submitted = editable.filter((c) => !(fields[c.name]?.auto ?? false));

    const cellsOf = (columns: DatabaseColumn[]): DatabaseCell[] =>
        columns.map((c) => {
            const field = fields[c.name] ?? { value: '', isNull: false, auto: false };
            return { column: c.name, value: field.isNull ? null : field.value };
        });

    const submit = async () => {
        if (busy || submitted.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            if (editing && row) {
                const key: DatabaseCell[] = structure.primaryKey.map((column) => ({
                    column,
                    value: row.values[row.columns.indexOf(column)] ?? null
                }));
                await api.send('database.rowUpdate', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    key,
                    values: cellsOf(submitted)
                });
            } else {
                await api.send('database.rowInsert', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    values: cellsOf(submitted)
                });
            }
            onSaved();
        } catch (e) {
            // Le message du moteur passe tel quel : « doublon », « clé
            // étrangère absente » sont des réponses utiles.
            setError(humanizeError(e, 'L’écriture a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const set = (column: string, patch: Partial<Field>) =>
        setFields((f) => ({
            ...f,
            [column]: { ...(f[column] ?? { value: '', isNull: false, auto: false }), ...patch }
        }));

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={editing ? 'Modifier la ligne' : 'Ajouter une ligne'}
            description={`${structure.table} — ${editable.length} colonne${editable.length > 1 ? 's' : ''} modifiable${editable.length > 1 ? 's' : ''}`}
            width={640}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || submitted.length === 0}>
                        {busy ? 'Écriture…' : editing ? 'Enregistrer' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {editing && (
                    <p className={styles.hint}>
                        Ligne désignée par sa clé primaire :{' '}
                        <code>
                            {structure.primaryKey
                                .map((c) => `${c} = ${row?.values[row.columns.indexOf(c)] ?? 'NULL'}`)
                                .join(', ')}
                        </code>
                    </p>
                )}

                <div className={styles.section}>
                    {editable.map((column) => {
                        const field = fields[column.name] ?? { value: '', isNull: false, auto: false };
                        return (
                            <label key={column.name} className={styles.field}>
                                <span className={styles.label}>
                                    {column.name}
                                    <span className={styles.columnType}>{column.type}</span>
                                    {!column.nullable && !field.auto && (
                                        <span className={styles.requiredMark}>obligatoire</span>
                                    )}
                                </span>

                                {field.auto ? (
                                    <button
                                        type='button'
                                        className={styles.autoField}
                                        onClick={() => set(column.name, { auto: false })}
                                    >
                                        <span className='icon icon-lock' aria-hidden='true' />
                                        Défini automatiquement — cliquer pour saisir une valeur
                                    </button>
                                ) : isLongText(column) ? (
                                    <textarea
                                        className={styles.sqlField}
                                        rows={3}
                                        value={field.isNull ? '' : field.value}
                                        disabled={field.isNull}
                                        spellCheck={false}
                                        onChange={(e) => set(column.name, { value: e.target.value })}
                                    />
                                ) : (
                                    <TextInput
                                        value={field.isNull ? '' : field.value}
                                        disabled={field.isNull}
                                        placeholder={column.default ?? ''}
                                        onChange={(e) => set(column.name, { value: e.target.value })}
                                    />
                                )}

                                {!field.auto && column.generated && !editing && (
                                    <button
                                        type='button'
                                        className={styles.autoBack}
                                        onClick={() => set(column.name, { auto: true, value: '', isNull: false })}
                                    >
                                        Laisser le moteur la remplir
                                    </button>
                                )}

                                {!field.auto && column.nullable && (
                                    <Checkbox
                                        checked={field.isNull}
                                        onChange={(checked) => set(column.name, { isNull: checked })}
                                    >
                                        <span className={styles.hint}>NULL</span>
                                    </Checkbox>
                                )}
                                {column.comment && <span className={styles.hint}>{column.comment}</span>}
                            </label>
                        );
                    })}
                </div>

                {editable.length === 0 && (
                    <p className={styles.warn}>
                        Cette table n’a que des colonnes qui composent sa clé primaire : il n’y a rien à modifier ici.
                    </p>
                )}

                {editable.length > 0 && submitted.length === 0 && (
                    <p className={styles.warn}>
                        Toutes les colonnes sont laissées au moteur : il n’y a rien à écrire. Ouvrez-en au moins une, ou
                        insérez la ligne depuis le terminal.
                    </p>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default RowDialog;
