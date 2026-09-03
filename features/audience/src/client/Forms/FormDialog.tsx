import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    humanizeError,
    invalidate,
    SaveButton,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import { AUDIENCE_FORM_NAME_MAX_LENGTH, type AudienceForm } from '../../contracts/domain';

import { api } from '../api';
import { formatCount } from '../format';
import styles from '../style.module.css';

interface FormDialogProps {
    form: AudienceForm | null;
    canWrite: boolean;
    onClose: () => void;
    /** Le formulaire n'existe plus, ou n'a plus le même nom : la vue se recharge. */
    onChanged: (removed: boolean) => void;
}

/**
 * Les réglages d'un formulaire : son nom, sa porte, et les deux gestes
 * destructeurs.
 *
 * Rien n'en crée : un formulaire naît de sa première réception. Le nom fait
 * partie de l'adressage, donc le renommer change ce que le site doit envoyer,
 * et l'ancien nom rouvrira un canal neuf au prochain envoi. Le dire ici est la
 * seule façon d'éviter la surprise.
 */
export function FormDialog({ form, canWrite, onClose, onChanged }: FormDialogProps) {
    const [name, setName] = useState('');
    const [open, setOpen] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (!form) return;
        setName(form.name);
        setOpen(form.open);
        setError(null);
    }, [form]);

    if (!form) return null;

    const save = async () => {
        try {
            await api.send('audience.formUpdate', { formId: form.id, name: name.trim(), open });
            invalidate('audience.forms', 'audience.detail');
            onChanged(false);
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        }
    };

    const run = async (send: () => Promise<unknown>, removed: boolean, fallback: string) => {
        try {
            await send();
            invalidate('audience.forms', 'audience.detail');
            onChanged(removed);
            onClose();
        } catch (e) {
            setError(humanizeError(e, fallback));
        } finally {
            setConfirm(null);
        }
    };

    return (
        <>
            <Dialog
                open
                onClose={onClose}
                title={`Formulaire « ${form.name} »`}
                description={`${formatCount(form.submissions)} retour${form.submissions > 1 ? 's' : ''} reçu${form.submissions > 1 ? 's' : ''}`}
                footer={
                    <>
                        <DialogCancelButton>Fermer</DialogCancelButton>
                        {canWrite && <SaveButton onSave={save}>Enregistrer</SaveButton>}
                    </>
                }
            >
                {error && <p className={styles.error}>{error}</p>}

                <TextInput
                    value={name}
                    maxLength={AUDIENCE_FORM_NAME_MAX_LENGTH}
                    disabled={!canWrite}
                    aria-label='Nom du formulaire'
                    onChange={(e) => setName(e.target.value)}
                />
                <p className={styles.fieldHint}>
                    C’est le nom que votre site envoie. Le changer ici veut dire le changer là-bas : sinon l’ancien nom
                    rouvrira un formulaire vide au prochain envoi.
                </p>

                <Switch
                    checked={open}
                    disabled={!canWrite}
                    label='Accepter les retours'
                    hint='Fermé, plus rien n’entre. Ce qui est déjà là ne bouge pas.'
                    onChange={setOpen}
                />

                {canWrite && (
                    <div className={styles.dialogActions}>
                        {/* Sans pictogramme : `trash` appartient à « Supprimer » juste
                            à côté, et les deux gestes ne doivent pas se ressembler. */}
                        <Button
                            variant='secondary'
                            disabled={form.submissions === 0}
                            onClick={() =>
                                setConfirm({
                                    title: 'Vider ce formulaire ?',
                                    description: `Ses ${formatCount(form.submissions)} retours et leurs répartitions disparaissent définitivement. Le formulaire reste, et continue de recevoir.`,
                                    confirmLabel: 'Vider',
                                    tone: 'danger',
                                    onConfirm: () =>
                                        run(
                                            () => api.send('audience.formClear', { formId: form.id }),
                                            false,
                                            'Vidage impossible.'
                                        )
                                })
                            }
                        >
                            Vider
                        </Button>
                        <Button
                            variant='danger'
                            icon='trash'
                            onClick={() =>
                                setConfirm({
                                    title: 'Supprimer ce formulaire ?',
                                    description:
                                        'Tout ce qu’il a reçu part avec lui. Supprimer n’empêche pas d’entrer : si votre site envoie encore ce nom, un formulaire vide réapparaîtra. Fermez-le plutôt.',
                                    confirmLabel: 'Supprimer',
                                    tone: 'danger',
                                    onConfirm: () =>
                                        run(
                                            () => api.send('audience.formRemove', { formId: form.id }),
                                            true,
                                            'Suppression impossible.'
                                        )
                                })
                            }
                        >
                            Supprimer
                        </Button>
                    </div>
                )}
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}

export default FormDialog;
