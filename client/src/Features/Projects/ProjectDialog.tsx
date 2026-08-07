import { useEffect, useState } from 'react';
import type { Project, ProjectDraft, ProjectSecurityTier, ProjectStatus, ProjectTag } from 'deveye-types';
import { PROJECT_MAX_TAGS, PROJECT_TAG_LABEL_MAX_LENGTH, PROJECT_TITLE_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { dateInputToSeconds, dateInputValue, STATUS_LABELS, TAG_KIND_LABELS } from './api';
import styles from './style.module.css';

const STATUSES: ProjectStatus[] = ['draft', 'active', 'paused', 'done'];

export interface ProjectDialogResult {
    draft: ProjectDraft;
    securityTier: ProjectSecurityTier;
}

interface ProjectDialogProps {
    open: boolean;
    /** `null` = création. */
    project: Project | null;
    /** Un espace partagé n'accepte pas le tier confidentiel (voir `_shared.ts`). */
    allowGuarded: boolean;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (result: ProjectDialogResult) => void;
}

const EMPTY: ProjectDraft = {
    title: '',
    description: '',
    tags: [],
    status: 'active',
    startDate: null,
    dueDate: null
};

/**
 * Formulaire de profil d'un projet — titre, description, étiquettes, statut,
 * fenêtre de dates, et à la création seulement le niveau de confidentialité.
 *
 * `holdSecrecy` : le formulaire *écrit* de la donnée chiffrée, une saisie longue
 * ne doit donc pas tomber sur la re-validation en cours de route.
 */
export function ProjectDialog({ open, project, allowGuarded, busy, error, onClose, onSubmit }: ProjectDialogProps) {
    const [draft, setDraft] = useState<ProjectDraft>(EMPTY);
    const [tier, setTier] = useState<ProjectSecurityTier>('open');
    const [tagKind, setTagKind] = useState<ProjectTag['kind']>('tech');
    const [tagLabel, setTagLabel] = useState('');

    // Recharge le formulaire à chaque ouverture : une popup réutilisée ne doit
    // jamais rouvrir sur les valeurs de la fois d'avant.
    useEffect(() => {
        if (!open) return;
        setDraft(
            project
                ? {
                      title: project.title,
                      description: project.description,
                      tags: project.tags,
                      status: project.status,
                      startDate: project.startDate,
                      dueDate: project.dueDate
                  }
                : EMPTY
        );
        setTier(project?.securityTier ?? 'open');
        setTagLabel('');
    }, [open, project]);

    const addTag = () => {
        const label = tagLabel.trim();
        if (!label || draft.tags.length >= PROJECT_MAX_TAGS) return;
        const exists = draft.tags.some((t) => t.kind === tagKind && t.label.toLowerCase() === label.toLowerCase());
        if (!exists) setDraft({ ...draft, tags: [...draft.tags, { kind: tagKind, label }] });
        setTagLabel('');
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
            title={project ? 'Modifier le projet' : 'Nouveau projet'}
            width={620}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !draft.title.trim()}>
                        {busy ? 'Enregistrement…' : project ? 'Enregistrer' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Titre</span>
                    <TextInput
                        data-autofocus
                        value={draft.title}
                        maxLength={PROJECT_TITLE_MAX_LENGTH}
                        placeholder='Nom du projet'
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                </label>

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

                {/* Le tier ne se change qu'ici, à la création : le basculer ensuite
                    re-chiffre tout l'arbre, c'est une action à part entière. */}
                {!project && allowGuarded && (
                    <label className={styles.field}>
                        <span className={styles.label}>Confidentialité</span>
                        <SelectInput value={tier} onChange={(e) => setTier(e.target.value as ProjectSecurityTier)}>
                            <option value='open'>Standard — chiffré, ouvert sans mot de passe</option>
                            <option value='guarded'>Confidentiel — demande votre mot de passe</option>
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
