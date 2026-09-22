import { useEffect, useRef, useState } from 'react';
import { ACCEPTED_TYPES, Button, Dialog, fileToSquareDataUrl, SelectInput, TextInput } from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';
import { dateInputToSeconds, dateInputValue, PROJECT_ICON_SIZE, STATUS_LABELS, STATUSES, TAG_KIND_LABELS } from './api';
import {
    PROJECT_ICON_MAX_LENGTH,
    PROJECT_MAX_TAGS,
    PROJECT_TAG_LABEL_MAX_LENGTH,
    PROJECT_TITLE_MAX_LENGTH,
    type ProjectDraft,
    type ProjectSecurityTier,
    type ProjectTag
} from '../contracts/domain';
import styles from './style.module.css';

export interface ProjectDialogResult {
    draft: ProjectDraft;
    securityTier: ProjectSecurityTier;
}

interface ProjectDialogProps {
    open: boolean;
    /** Un espace partagé n'accepte pas le tier confidentiel (voir `_shared.ts`). */
    allowGuarded: boolean;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (result: ProjectDialogResult) => void;
}

const EMPTY: ProjectDraft = {
    title: '',
    icon: '',
    description: '',
    tags: [],
    status: 'active',
    // Le tableau suffit à un projet neuf : la vue d'ensemble se demande, la frise vient d'office.
    showOverview: false,
    showTimeline: true,
    startDate: null,
    dueDate: null
};

/**
 * Créer un projet. Rien d'autre : une fois né, un projet se règle dans l'onglet
 * Général de sa fiche, comme tout élément. Le niveau de confidentialité ne se
 * choisit qu'ici : le basculer ensuite re-chiffre tout l'arbre, c'est une
 * action à part entière.
 *
 * `holdSecrecy` parce que le formulaire écrit de la donnée chiffrée : une
 * saisie longue ne doit pas tomber sur la re-validation.
 */
export function ProjectDialog({ open, allowGuarded, busy, error, onClose, onSubmit }: ProjectDialogProps) {
    const [draft, setDraft] = useState<ProjectDraft>(EMPTY);
    const [tier, setTier] = useState<ProjectSecurityTier>('open');
    const [tagKind, setTagKind] = useState<ProjectTag['kind']>('tech');
    const [tagLabel, setTagLabel] = useState('');
    const [iconError, setIconError] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Repart de zéro à chaque ouverture : une popup réutilisée ne doit jamais
    // rouvrir sur la saisie de la fois d'avant.
    useEffect(() => {
        if (!open) return;
        setDraft(EMPTY);
        setTier('open');
        setTagLabel('');
        setIconError(null);
    }, [open]);

    const addTag = () => {
        const label = tagLabel.trim();
        if (!label || draft.tags.length >= PROJECT_MAX_TAGS) return;
        const exists = draft.tags.some((t) => t.kind === tagKind && t.label.toLowerCase() === label.toLowerCase());
        if (!exists) setDraft({ ...draft, tags: [...draft.tags, { kind: tagKind, label }] });
        setTagLabel('');
    };

    /**
     * Réduit l'image déposée et la pose dans le brouillon. Un échec n'efface pas
     * l'icône en place et ne bloque rien : il s'affiche sous le titre.
     */
    const pickIcon = async (file: File | null) => {
        if (!file) return;
        try {
            setDraft((d) => ({ ...d, icon: '' }));
            const icon = await fileToSquareDataUrl(file, {
                size: PROJECT_ICON_SIZE,
                maxLength: PROJECT_ICON_MAX_LENGTH
            });
            setDraft((d) => ({ ...d, icon }));
            setIconError(null);
        } catch (e) {
            setIconError(e instanceof Error ? e.message : 'Image refusée.');
        }
    };

    const removeTag = (index: number) => setDraft({ ...draft, tags: draft.tags.filter((_, i) => i !== index) });

    const submit = () => {
        if (busy || !draft.title.trim()) return;
        onSubmit({ draft: { ...draft, title: draft.title.trim() }, securityTier: tier });
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Nouveau projet'
            width={620}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !draft.title.trim()}>
                        {busy ? 'Enregistrement…' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {/* L'image est réduite dans le navigateur avant d'être envoyée :
                    le contrat borne la charge utile. */}
                <div className={styles.iconRow}>
                    <button
                        type='button'
                        className={styles.iconPicker}
                        onClick={() => fileRef.current?.click()}
                        title='Choisir une image'
                        aria-label='Choisir une icône pour le projet'
                    >
                        {draft.icon ? (
                            <img src={draft.icon} alt='' />
                        ) : (
                            <span className='icon icon-projects' aria-hidden='true' />
                        )}
                    </button>
                    <input
                        ref={fileRef}
                        type='file'
                        accept={ACCEPTED_TYPES.join(',')}
                        hidden
                        onChange={(e) => void pickIcon(e.target.files?.[0] ?? null)}
                    />

                    <label className={styles.field}>
                        <span className={styles.label}>Titre</span>
                        <TextInput
                            data-autofocus
                            value={draft.title}
                            maxLength={PROJECT_TITLE_MAX_LENGTH}
                            placeholder='Nom du projet'
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        />
                        <span className={iconError ? styles.error : styles.hint}>
                            {iconError ??
                                (draft.icon
                                    ? 'Cliquez sur la vignette pour la remplacer.'
                                    : 'Cliquez sur la vignette pour choisir une image (PNG, JPEG ou WebP).')}
                        </span>
                    </label>

                    {draft.icon && (
                        <Button variant='ghost' onClick={() => setDraft({ ...draft, icon: '' })}>
                            Retirer
                        </Button>
                    )}
                </div>

                <label className={styles.field}>
                    <span className={styles.label}>Description</span>
                    <textarea
                        className={styles.textarea}
                        value={draft.description}
                        rows={4}
                        placeholder='À quoi sert ce projet ?'
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                </label>

                <div className={styles.row}>
                    <label className={styles.field}>
                        <span className={styles.label}>Statut</span>
                        <SelectInput
                            value={draft.status}
                            onChange={(e) => setDraft({ ...draft, status: e.target.value as ProjectStatus })}
                        >
                            {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {STATUS_LABELS[s]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Début</span>
                        <TextInput
                            type='date'
                            value={dateInputValue(draft.startDate)}
                            onChange={(e) => setDraft({ ...draft, startDate: dateInputToSeconds(e.target.value) })}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Échéance</span>
                        <TextInput
                            type='date'
                            value={dateInputValue(draft.dueDate)}
                            onChange={(e) => setDraft({ ...draft, dueDate: dateInputToSeconds(e.target.value) })}
                        />
                    </label>
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>Étiquettes</span>
                    <div className={styles.tagRow}>
                        <SelectInput value={tagKind} onChange={(e) => setTagKind(e.target.value as ProjectTag['kind'])}>
                            <option value='type'>{TAG_KIND_LABELS.type}</option>
                            <option value='tech'>{TAG_KIND_LABELS.tech}</option>
                        </SelectInput>
                        <TextInput
                            value={tagLabel}
                            maxLength={PROJECT_TAG_LABEL_MAX_LENGTH}
                            placeholder={tagKind === 'type' ? 'site web, app mobile…' : 'react, express…'}
                            onChange={(e) => setTagLabel(e.target.value)}
                        />
                        <Button variant='secondary' onClick={addTag} disabled={!tagLabel.trim()}>
                            Ajouter
                        </Button>
                    </div>
                    {draft.tags.length > 0 && (
                        <ul className={styles.tags}>
                            {draft.tags.map((tag, i) => (
                                <li key={`${tag.kind}:${tag.label}`} className={styles.tag} data-kind={tag.kind}>
                                    {tag.label}
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Retirer ${tag.label}`}
                                        onClick={() => removeTag(i)}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {allowGuarded && (
                    <label className={styles.field}>
                        <span className={styles.label}>Confidentialité</span>
                        <SelectInput value={tier} onChange={(e) => setTier(e.target.value as ProjectSecurityTier)}>
                            <option value='open'>Standard : chiffré, ouvert sans mot de passe</option>
                            <option value='guarded'>Confidentiel : demande votre mot de passe</option>
                        </SelectInput>
                        <span className={styles.hint}>
                            Un projet confidentiel ne peut pas être synchronisé avec un dépôt git ni déclencher un
                            déploiement : ces tâches tournent sans session.
                        </span>
                    </label>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default ProjectDialog;
