import { useEffect, useState } from 'react';
import type { ProjectColumn } from 'deveye-types';
import { PROJECT_COLUMN_NAME_MAX_LENGTH } from 'deveye-types';
import { Button, Checkbox, Dialog, TextInput } from '@/Components';
import styles from '../style.module.css';

export interface ColumnDialogResult {
    name: string;
    countsAsDone: boolean;
    wipLimit: number | null;
}

interface ColumnDialogProps {
    open: boolean;
    /** `null` = création. */
    column: ProjectColumn | null;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (result: ColumnDialogResult) => void;
    onRemove?: () => void;
}

export function ColumnDialog({ open, column, busy, error, onClose, onSubmit, onRemove }: ColumnDialogProps) {
    const [name, setName] = useState('');
    const [countsAsDone, setCountsAsDone] = useState(false);
    const [wipLimit, setWipLimit] = useState('');

    useEffect(() => {
        if (!open) return;
        setName(column?.name ?? '');
        setCountsAsDone(column?.countsAsDone ?? false);
        setWipLimit(column?.wipLimit === null || column?.wipLimit === undefined ? '' : String(column.wipLimit));
    }, [open, column]);

    const submit = () => {
        if (busy || !name.trim()) return;
        const parsed = wipLimit.trim() ? Number(wipLimit) : null;
        onSubmit({
            name: name.trim(),
            countsAsDone,
            wipLimit: parsed !== null && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
        });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={column ? 'Modifier la colonne' : 'Nouvelle colonne'}
            width={480}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    {column && onRemove && (
                        <Button variant='danger' icon='trash' onClick={onRemove} disabled={busy}>
                            Retirer
                        </Button>
                    )}
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !name.trim()}>
                        {busy ? 'Enregistrement…' : column ? 'Enregistrer' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Nom</span>
                    <TextInput
                        data-autofocus
                        value={name}
                        maxLength={PROJECT_COLUMN_NAME_MAX_LENGTH}
                        placeholder='À faire, En revue…'
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                <Checkbox checked={countsAsDone} onChange={setCountsAsDone}>
                    <>
                        Cette colonne vaut « terminé »
                        <span className={styles.hint}>
                            C’est ce qui fait avancer la barre de progression du projet.
                        </span>
                    </>
                </Checkbox>

                <label className={styles.field}>
                    <span className={styles.label}>Limite de travail en cours</span>
                    <TextInput
                        type='number'
                        min={1}
                        value={wipLimit}
                        placeholder='Aucune'
                        onChange={(e) => setWipLimit(e.target.value)}
                    />
                    <span className={styles.hint}>
                        Indicative : au-delà, le compteur passe en alerte, mais rien n’est bloqué.
                    </span>
                </label>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default ColumnDialog;
