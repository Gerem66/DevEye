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
    /**
     * Le moteur s'en charge, et on le laisse faire.
     *
     * Vrai au départ pour toute colonne qu'il remplit seul — l'auto-incrément,
     * l'horodatage par défaut. Le champ n'est alors pas envoyé du tout, ce qui
     * n'est pas la même chose que d'envoyer une chaîne vide.
     */
    auto: boolean;
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
 * ## Les colonnes que le moteur remplit
 *
 * Identifiant auto-incrémenté, horodatage de création : elles sont **à leur
 * place**, dans l'ordre de la table, mais fermées — un bouton dit que le moteur
 * s'en charge, et l'ouvre si l'on veut malgré tout imposer une valeur. Elles
 * étaient auparavant retirées du formulaire, avec une phrase pour l'expliquer :
 * l'ordre des champs ne correspondait plus à celui de la table, et rien ne
 * permettait de forcer un identifiant lors d'une reprise de données. Ouvrir un
 * champ ne le rend pas obligatoire : laissé fermé, il n'est pas envoyé du tout.
 *
 * La clé primaire à la **modification** reste, elle, hors du formulaire : c'est
 * elle qui désigne la ligne qu'on est en train de changer.
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
                // À l'ajout, une colonne nullable part sur `NULL` plutôt que sur
                // une chaîne vide : c'est ce que fait le moteur sans nous. Une
                // colonne qu'il remplit seul n'a, elle, aucun `NULL` à porter.
                isNull: !auto && (current === null || (current === undefined && column.nullable)),
                auto
            };
        }
        setFields(next);
    }, [open, structure, row, editing]);

    /** Les colonnes qu'on peut réellement renseigner dans ce contexte. */
    const editable = structure.columns.filter((c) => !editing || !structure.primaryKey.includes(c.name));

    /** Celles qui partiront vraiment : une colonne laissée au moteur n'y est pas. */
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
                await ws.send('database.rowUpdate', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    key,
                    values: cellsOf(submitted)
                });
            } else {
                await ws.send('database.rowInsert', {
                    databaseId,
                    schema: structure.schema,
                    table: structure.table,
                    values: cellsOf(submitted)
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
                                    /* À la place du champ, et non à la place de
                                       la ligne : la colonne garde son rang dans
                                       la table, on voit juste qui la remplit. */
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
