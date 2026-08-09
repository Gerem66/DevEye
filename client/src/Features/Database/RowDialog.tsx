import { useEffect, useState } from 'react';
import type { DatabaseCell, DatabaseColumn, DatabaseStructure } from 'deveye-types';
import { Button, Checkbox, Dialog, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import styles from './style.module.css';

interface RowDialogProps {
    open: boolean;
    databaseId: number;
    structure: DatabaseStructure;
    /**
     * La ligne modifiée, valeurs dans l'ordre de `columns` ; `null` = ajout.
     * Sa clé primaire sert à la désigner, et n'est donc pas modifiable.
     */
    row: { columns: string[]; values: (string | null)[] } | null;
    onClose: () => void;
    onSaved: () => void;
}

/** Ce qu'un champ tient : une valeur, ou la marque explicite d'un `NULL`. */
interface Field {
    value: string;
    isNull: boolean;
}

/** Une longue valeur mérite une zone multiligne plutôt qu'un champ d'une ligne. */
function isLongText(column: DatabaseColumn): boolean {
    return /text|json|blob|bytea|xml/i.test(column.type);
}

/**
 * Ajouter ou modifier une ligne.
 *
 * Un champ par colonne réelle de la table, dans l'ordre de la table : c'est la
 * seule disposition qui permette de retrouver une colonne sans la chercher, et
 * elle vient du serveur, pas d'une liste tenue à la main ici.
 *
 * ## `NULL` n'est pas la chaîne vide
 *
 * Les deux existent, et les confondre viderait une colonne au lieu de la laisser
 * nulle — ou l'inverse. Chaque colonne nullable porte donc sa case « NULL »,
 * qui grise le champ tant qu'elle est cochée.
 *
 * ## Ce que le formulaire ne propose pas
 *
 * Les colonnes que le moteur remplit seul (auto-incrément, identité, colonnes
 * calculées) à l'ajout : les renseigner serait au mieux ignoré, au pire refusé.
 * Et la clé primaire à la modification : c'est elle qui désigne la ligne qu'on
 * est en train de changer.
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
            next[column.name] = {
                value: current ?? '',
                // À l'ajout, une colonne nullable part sur `NULL` plutôt que sur
                // une chaîne vide : c'est ce que fait le moteur sans nous.
                isNull: current === null || (current === undefined && column.nullable)
            };
        }
        setFields(next);
    }, [open, structure, row]);

    /** Les colonnes qu'on peut réellement renseigner dans ce contexte. */
    const editable = structure.columns.filter((c) => {
        if (editing) return !structure.primaryKey.includes(c.name);
        return !c.generated;
    });

    const cellsOf = (columns: DatabaseColumn[]): DatabaseCell[] =>
        columns.map((c) => {
            const field = fields[c.name] ?? { value: '', isNull: false };
            return { column: c.name, value: field.isNull ? null : field.value };
        });

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            if (editing && row) {
                const key: DatabaseCell[] = structure.primaryKey.map((column) => ({
                    column,
                    value: row.values[row.columns.indexOf(column)] ?? null
                }));
                await ws.send('database.rowUpdate', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    key,
                    values: cellsOf(editable)
                });
            } else {
                await ws.send('database.rowInsert', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    values: cellsOf(editable)
                });
            }
            onSaved();
        } catch (e) {
            // Le message du moteur passe tel quel : « champ obligatoire »,
            // « doublon », « clé étrangère absente » sont des réponses utiles,
            // bien plus qu'un « échec » générique.
            setError(humanizeError(e, 'L’écriture a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const set = (column: string, patch: Partial<Field>) =>
        setFields((f) => ({ ...f, [column]: { ...(f[column] ?? { value: '', isNull: false }), ...patch } }));

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
                    <Button onClick={() => void submit()} disabled={busy || editable.length === 0}>
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
                        const field = fields[column.name] ?? { value: '', isNull: false };
                        return (
                            <label key={column.name} className={styles.field}>
                                <span className={styles.label}>
                                    {column.name}
                                    <span className={styles.columnType}>{column.type}</span>
                                    {!column.nullable && <span className={styles.requiredMark}>obligatoire</span>}
                                </span>

                                {isLongText(column) ? (
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

                                {column.nullable && (
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
                        Cette table n’a que des colonnes que le moteur remplit lui-même
                        {editing && ' ou qui composent sa clé primaire'} : il n’y a rien à saisir ici.
                    </p>
                )}

                {!editing && structure.columns.some((c) => c.generated) && (
                    <p className={styles.hint}>
                        Non proposées, parce que le moteur les remplit lui-même :{' '}
                        {structure.columns
                            .filter((c) => c.generated)
                            .map((c) => c.name)
                            .join(', ')}
                        .
                    </p>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default RowDialog;
