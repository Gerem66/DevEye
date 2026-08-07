import { useEffect, useState } from 'react';
import type { ProjectMilestone, ProjectMilestoneDraft } from 'deveye-types';
import { PROJECT_MILESTONE_NAME_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, TextInput } from '@/Components';
import { dateInputToSeconds, dateInputValue } from '../api';
import styles from '../style.module.css';

interface MilestoneDialogProps {
    open: boolean;
    /** `null` = création. */
    milestone: ProjectMilestone | null;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (draft: ProjectMilestoneDraft) => void;
    onSetReached?: (reached: boolean) => void;
    onRemove?: () => void;
}

export function MilestoneDialog({
    open,
    milestone,
    busy,
    error,
    onClose,
    onSubmit,
    onSetReached,
    onRemove
}: MilestoneDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [dueDate, setDueDate] = useState('');

    useEffect(() => {
        if (!open) return;
        setName(milestone?.name ?? '');
        setDescription(milestone?.description ?? '');
        setDueDate(dateInputValue(milestone?.dueDate ?? Math.floor(Date.now() / 1000)));
    }, [open, milestone]);

    const submit = () => {
        const due = dateInputToSeconds(dueDate);
        if (busy || !name.trim() || due === null) return;
        onSubmit({ name: name.trim(), description, dueDate: due });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={milestone ? 'Modifier le jalon' : 'Nouveau jalon'}
            width={520}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    {milestone && onRemove && (
                        <Button variant='danger' icon='trash' onClick={onRemove} disabled={busy}>
                            Retirer
                        </Button>
                    )}
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !name.trim() || !dueDate}>
                        {busy ? 'Enregistrement…' : milestone ? 'Enregistrer' : 'Créer'}
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
                        maxLength={PROJECT_MILESTONE_NAME_MAX_LENGTH}
                        placeholder='Bêta publique, v1.0…'
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Échéance</span>
                    <TextInput type='date' value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </label>

                <label className={styles.field}>
                    <span className={styles.label}>Description</span>
                    <textarea
                        className={styles.textarea}
                        value={description}
                        rows={3}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </label>

                {milestone && onSetReached && (
                    <label className={styles.checkRow}>
                        <input
                            type='checkbox'
                            checked={milestone.reachedAt !== null}
                            onChange={(e) => onSetReached(e.target.checked)}
                        />
                        <span>
                            Jalon atteint
                            {milestone.reachedAt !== null && (
                                <span className={styles.hint}>
                                    Le {new Date(milestone.reachedAt * 1000).toLocaleDateString('fr-FR')}
                                </span>
                            )}
                        </span>
                    </label>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default MilestoneDialog;
