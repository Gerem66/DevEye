import {
    Button,
    Dialog,
    DialogCancelButton,
    errorNote,
    ErrorNote,
    invalidate,
    settingsStyles as shell,
    TextInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useState } from 'react';

import { normaliseSlug, SHORTLINK_TITLE_MAX, SHORTLINK_URL_MAX } from '../contracts/domain';
import AddressFields, { slugValid } from './AddressFields';
import { api } from './api';
import { isHttpUrl } from './format';
import styles from './style.module.css';

interface Form {
    target: string;
    title: string;
    domainId: number | null;
    slug: string;
}

const EMPTY: Form = { target: '', title: '', domainId: null, slug: '' };

/**
 * Créer un lien : où il mène, un titre facultatif, et son adresse. Le dialogue
 * ne fait que créer ; mot de passe, fin, destinations par appareil et campagne
 * se règlent ensuite dans ses réglages.
 */
export default function LinkDialog({
    open,
    onClose,
    onCreated
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (id: number) => void;
}) {
    const [form, setForm] = useState<Form>(EMPTY);
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (!open) return;
        setForm(EMPTY);
        setTouched(false);
        setError(null);
    }, [open]);

    const target = form.target.trim();
    const targetInvalid = !isHttpUrl(target);
    const slugInvalid = form.domainId !== null && !slugValid(form.slug);
    const set = (change: Partial<Form>) => setForm((current) => ({ ...current, ...change }));

    const submit = async (): Promise<void> => {
        setTouched(true);
        if (busy || targetInvalid || slugInvalid) return;
        setBusy(true);
        setError(null);
        try {
            const { link } = await api.send('shortlinks.add', {
                link: {
                    title: form.title.trim(),
                    target,
                    domainId: form.domainId,
                    slug: form.domainId === null ? null : normaliseSlug(form.slug)
                }
            });
            invalidate('shortlinks.list', 'shortlinks.count', 'shortlinks.stats');
            onCreated(link.id);
            onClose();
        } catch (failure) {
            // Une limite atteinte ouvre d'elle-même la proposition des offres ;
            // la phrase du serveur reste ici pour qui la ferme.
            setError(errorNote(failure, 'Le lien n’a pas pu être créé.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Nouveau lien'
            description='Collez une longue adresse : DevEye vous donne un lien court qui y mène, et compte les visites.'
            onSubmit={() => void submit()}
            footer={
                <>
                    <DialogCancelButton variant='ghost'>Annuler</DialogCancelButton>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Création…' : 'Créer le lien'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={shell.field}>
                    <label className={shell.fieldLabel} htmlFor='shortlinks-new-target'>
                        Destination
                    </label>
                    <TextInput
                        id='shortlinks-new-target'
                        type='url'
                        inputMode='url'
                        autoComplete='off'
                        spellCheck={false}
                        value={form.target}
                        maxLength={SHORTLINK_URL_MAX}
                        placeholder='https://exemple.fr/une/adresse/tres/longue'
                        data-autofocus=''
                        required
                        aria-invalid={touched && targetInvalid}
                        error={
                            touched && targetInvalid
                                ? 'Une adresse web complète, qui commence par https:// ou http://'
                                : undefined
                        }
                        onBlur={() => setTouched(form.target.trim().length > 0 || touched)}
                        onChange={(event) => set({ target: event.target.value })}
                    />
                </div>

                <div className={shell.field}>
                    <label className={shell.fieldLabel} htmlFor='shortlinks-new-title'>
                        Titre (facultatif)
                    </label>
                    <TextInput
                        id='shortlinks-new-title'
                        value={form.title}
                        maxLength={SHORTLINK_TITLE_MAX}
                        placeholder='Promo de printemps'
                        onChange={(event) => set({ title: event.target.value })}
                    />
                    <span className={shell.fieldHint}>
                        Pour le reconnaître dans la liste. Les visiteurs ne le voient pas.
                    </span>
                </div>

                <AddressFields
                    idPrefix='shortlinks-new'
                    domainId={form.domainId}
                    slug={form.slug}
                    labelClassName={shell.fieldLabel}
                    onChange={(next) => set(next)}
                />

                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}
