import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    humanizeError,
    invalidate,
    SaveButton,
    SearchSelect,
    SegmentedControl,
    openInfo,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import {
    AUDIENCE_FIELD_CHOICES_MAX,
    AUDIENCE_FIELD_NAME_MAX_LENGTH,
    AUDIENCE_FORM_FIELDS_MAX,
    AUDIENCE_FORM_NAME_MAX_LENGTH,
    audienceFieldKindSchema,
    type AudienceFieldKind,
    type AudienceForm,
    type AudienceFormField,
    type AudienceFormMode
} from '../contracts/domain';

import { api } from './api';
import { FIELD_FORMAT_HELP, FIELD_KIND_LABELS, fieldExampleValue, formatCount } from './format';
import styles from './style.module.css';

/** Une ligne de l'éditeur : les choix restent du texte tant qu'on les tape. */
interface FieldDraft {
    name: string;
    kind: AudienceFieldKind;
    required: boolean;
    /** Un choix par ligne, comme les origines : le découpage se fait à l'envoi. */
    choices: string;
    multiple: boolean;
}

interface FormEditorProps {
    /** `null` = déclarer un formulaire ; sinon on modifie celui-ci. */
    form: AudienceForm | null;
    siteId: number;
    open: boolean;
    canWrite: boolean;
    onClose: () => void;
    onSaved: () => void;
}

const KIND_OPTIONS = audienceFieldKindSchema.options.map((value) => ({ value, label: FIELD_KIND_LABELS[value] }));

function toDraft(field: AudienceFormField): FieldDraft {
    return { ...field, choices: field.choices.join('\n') };
}

function fromDraft(draft: FieldDraft): AudienceFormField {
    const choices =
        draft.kind === 'choice'
            ? draft.choices
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0)
            : [];
    return {
        name: draft.name.trim(),
        kind: draft.kind,
        required: draft.required,
        choices,
        // Hors d'un champ à choix, le contrat exige que ces deux-là soient vides :
        // les garder ferait ressusciter des réponses possibles après un changement
        // de type.
        multiple: draft.kind === 'choice' && draft.multiple
    };
}

/**
 * Ce que ce type accepte, montré là où on le choisit. Le format attendu se
 * décide ici et se subit à l'autre bout : le lire au moment du choix évite
 * l'aller-retour « pourquoi mon envoi est refusé ».
 */
function explainKind(field: AudienceFormField): void {
    const help = FIELD_FORMAT_HELP[field.kind];
    const name = field.name.trim() || 'question';
    void openInfo({
        title: `${FIELD_KIND_LABELS[field.kind]} : format attendu`,
        width: 520,
        body: (
            <div className={styles.formatHelp}>
                <p className={shell.fieldHint}>
                    <strong>Ce qu’on peut envoyer.</strong> {help.accepts}
                </p>
                <p className={shell.fieldHint}>
                    <strong>Ce qui est rangé.</strong> {help.stored}
                </p>
                {field.kind === 'choice' && field.choices.length > 0 && (
                    <p className={shell.fieldHint}>
                        Réponses déclarées : {field.choices.map((choice) => `« ${choice} »`).join(', ')}.
                    </p>
                )}
                {field.required && (
                    <p className={shell.fieldHint}>
                        Cette question est <strong>requise</strong> : un envoi qui l’omet est refusé en entier.
                    </p>
                )}
                <pre className={styles.raw}>{`{ "${name}": ${fieldExampleValue(field)} }`}</pre>
                <p className={shell.fieldHint}>
                    « Installer » engendre le formulaire complet et le mémo pour un agent, avec ces types.
                </p>
            </div>
        )
    });
}

/**
 * Déclarer un formulaire : son nom, son mode, et ses questions.
 *
 * C'est ici que se joue la correction du premier jet, où un canal naissait de
 * sa première réception : le nom que le site enverra et la forme de ce qu'il
 * enverra sont décidés ici, par quelqu'un qui a le droit d'écrire, et pas par
 * qui lit la clé publique dans la page.
 *
 * Le type d'une question n'est pas une décoration : c'est lui qui ramène le
 * `"4"` d'un formulaire HTML au nombre 4 avant qu'on le range, qui laisse
 * engendrer la balise à coller, et qui fait apparaître dans les résultats une
 * question que personne n'a remplie.
 */
export function FormEditor({ form, siteId, open, canWrite, onClose, onSaved }: FormEditorProps) {
    const [name, setName] = useState('');
    const [mode, setMode] = useState<AudienceFormMode>('strict');
    const [fields, setFields] = useState<FieldDraft[]>([]);
    const [accepting, setAccepting] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (!open) return;
        setName(form?.name ?? '');
        setMode(form?.mode ?? 'strict');
        setFields((form?.fields ?? []).map(toDraft));
        setAccepting(form?.open ?? true);
        setError(null);
    }, [open, form]);

    if (!open) return null;

    const setField = (index: number, patch: Partial<FieldDraft>) =>
        setFields((prev) => prev.map((field, i) => (i === index ? { ...field, ...patch } : field)));

    const save = async () => {
        const declared = fields.map(fromDraft);
        const problem =
            name.trim().length === 0
                ? 'Donnez un nom à ce formulaire.'
                : mode === 'strict' && declared.length === 0
                  ? 'Un formulaire strict sans question n’accepterait rien. Ajoutez-en une, ou passez en mode libre.'
                  : declared.some((field) => field.name.length === 0)
                    ? 'Une question sans nom ne peut pas être renseignée.'
                    : new Set(declared.map((f) => f.name)).size !== declared.length
                      ? 'Deux questions portent le même nom.'
                      : declared.some((field) => field.kind === 'choice' && field.choices.length === 0)
                        ? 'Une question à choix doit proposer au moins une réponse.'
                        : null;
        if (problem) {
            setError(problem);
            throw new Error(problem);
        }

        try {
            if (form) {
                await api.send('audience.formUpdate', {
                    formId: form.id,
                    name: name.trim(),
                    mode,
                    fields: declared,
                    open: accepting
                });
            } else {
                await api.send('audience.formAdd', { siteId, name: name.trim(), mode, fields: declared });
            }
            invalidate('audience.forms', 'audience.detail');
            onSaved();
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        }
    };

    const run = async (send: () => Promise<unknown>, close: boolean, fallback: string) => {
        try {
            await send();
            invalidate('audience.forms', 'audience.detail');
            onSaved();
            if (close) onClose();
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
                title={form ? `Formulaire « ${form.name} »` : 'Déclarer un formulaire'}
                description={
                    form
                        ? `${formatCount(form.submissions)} retour${form.submissions > 1 ? 's' : ''} reçu${form.submissions > 1 ? 's' : ''}`
                        : 'Le nom et les questions que votre site enverra.'
                }
                width={680}
                footer={
                    <>
                        <DialogCancelButton>Fermer</DialogCancelButton>
                        {canWrite && <SaveButton onSave={save}>Enregistrer</SaveButton>}
                    </>
                }
            >
                {error && <p className={shell.notice}>{error}</p>}

                <label className={shell.field}>
                    <span className={shell.sectionLabel}>Nom</span>
                    <TextInput
                        value={name}
                        maxLength={AUDIENCE_FORM_NAME_MAX_LENGTH}
                        disabled={!canWrite}
                        placeholder='contact, sondage-2026…'
                        onChange={(e) => setName(e.target.value)}
                    />
                    <span className={shell.fieldHint}>
                        C’est le nom que votre site envoie. Le changer ici veut dire le changer là-bas, sinon l’ancien
                        se présentera comme un inconnu.
                    </span>
                </label>

                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Ce qui est accepté</span>
                    <SegmentedControl
                        value={mode}
                        options={[
                            { value: 'strict', label: 'Questions déclarées' },
                            { value: 'auto', label: 'Champs libres' }
                        ]}
                        disabled={!canWrite}
                        onChange={(v) => setMode(v as AudienceFormMode)}
                        aria-label='Ce qui est accepté'
                    />
                    <span className={mode === 'auto' ? shell.warning : shell.fieldHint}>
                        {mode === 'strict'
                            ? 'Seules les questions ci-dessous sont acceptées, et leurs valeurs sont ramenées à leur type. Un envoi qui ne colle pas est refusé en entier.'
                            : 'Tout est accepté et les colonnes se découvrent. Pratique quand le site change plus vite que ses réglages, au prix de laisser qui a la clé publique décider de ce qui s’affiche.'}
                    </span>
                </div>

                {mode === 'strict' && (
                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>Questions</span>
                        {fields.length === 0 && <p className={shell.empty}>Aucune question déclarée.</p>}

                        {fields.map((field, index) => (
                            <div key={index} className={styles.fieldRow}>
                                <TextInput
                                    value={field.name}
                                    maxLength={AUDIENCE_FIELD_NAME_MAX_LENGTH}
                                    disabled={!canWrite}
                                    placeholder='email, message…'
                                    aria-label='Nom de la question'
                                    onChange={(e) => setField(index, { name: e.target.value })}
                                />
                                <SearchSelect
                                    value={field.kind}
                                    disabled={!canWrite}
                                    aria-label='Type'
                                    onChange={(kind) => setField(index, { kind })}
                                    options={KIND_OPTIONS}
                                />
                                <Switch
                                    checked={field.required}
                                    disabled={!canWrite}
                                    label='Requise'
                                    onChange={(v) => setField(index, { required: v })}
                                />
                                <Button
                                    variant='ghost'
                                    icon='info'
                                    aria-label={`Format attendu pour « ${field.name.trim() || 'cette question'} »`}
                                    title='Format attendu'
                                    onClick={() => explainKind(fromDraft(field))}
                                />
                                <Button
                                    variant='ghost'
                                    icon='trash'
                                    disabled={!canWrite}
                                    aria-label='Retirer cette question'
                                    onClick={() => setFields((prev) => prev.filter((_, i) => i !== index))}
                                />

                                {field.kind === 'choice' && (
                                    <div className={styles.fieldChoices}>
                                        <textarea
                                            className={styles.choices}
                                            value={field.choices}
                                            rows={2}
                                            disabled={!canWrite}
                                            aria-label='Réponses possibles'
                                            placeholder={'Une réponse par ligne'}
                                            onChange={(e) => setField(index, { choices: e.target.value })}
                                        />
                                        <Switch
                                            checked={field.multiple}
                                            disabled={!canWrite}
                                            label='Plusieurs réponses'
                                            hint={`Jusqu’à ${AUDIENCE_FIELD_CHOICES_MAX} réponses possibles.`}
                                            onChange={(v) => setField(index, { multiple: v })}
                                        />
                                    </div>
                                )}
                            </div>
                        ))}

                        {canWrite && fields.length < AUDIENCE_FORM_FIELDS_MAX && (
                            <div className={styles.addRow}>
                                <Button
                                    variant='secondary'
                                    icon='add'
                                    onClick={() =>
                                        setFields((prev) => [
                                            ...prev,
                                            { name: '', kind: 'text', required: false, choices: '', multiple: false }
                                        ])
                                    }
                                >
                                    Ajouter une question
                                </Button>
                            </div>
                        )}
                    </div>
                )}

                {form && (
                    <>
                        <Switch
                            checked={accepting}
                            disabled={!canWrite}
                            label='Accepter les retours'
                            hint={
                                form.closedReason === 'full'
                                    ? 'Fermé tout seul : les 50 000 retours qu’il peut garder sont atteints. Videz-le avant de rouvrir.'
                                    : 'Fermé, plus rien n’entre. Ce qui est déjà là ne bouge pas.'
                            }
                            onChange={setAccepting}
                        />

                        {canWrite && (
                            <div className={shell.sectionActions}>
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
                                            description: `Ses ${formatCount(form.submissions)} retours partent avec lui, et le site ne pourra plus lui écrire tant qu’il n’est pas redéclaré.`,
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
                    </>
                )}
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}

export default FormEditor;
