import { useEffect, useRef, useState } from 'react';
import {
    ACCEPTED_TYPES,
    Button,
    ConfirmDialog,
    fileToSquareDataUrl,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SelectInput,
    settingsStyles as shell,
    Switch,
    TextInput,
    useWorkspacePermissions,
    withSecrecy,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    PROJECT_ICON_MAX_LENGTH,
    PROJECT_MAX_TAGS,
    PROJECT_TAG_LABEL_MAX_LENGTH,
    PROJECT_TITLE_MAX_LENGTH,
    type Project,
    type ProjectDraft,
    type ProjectTag
} from '../contracts/domain';

import {
    api,
    dateInputToSeconds,
    dateInputValue,
    PROJECT_ICON_SIZE,
    STATUS_LABELS,
    STATUSES,
    TAG_KIND_LABELS
} from './api';
import styles from './style.module.css';

function draftOf(project: Project): ProjectDraft {
    return {
        title: project.title,
        icon: project.icon,
        description: project.description,
        tags: project.tags,
        status: project.status,
        showOverview: project.showOverview,
        showTimeline: project.showTimeline,
        startDate: project.startDate,
        dueDate: project.dueDate
    };
}

/**
 * Le projet lui-même : son profil (vignette, titre, description, statut, dates,
 * étiquettes) et son archivage. L'onglet Général de ses réglages, là où le
 * bouton commun mène.
 *
 * C'est le formulaire qui vivait dans un dialogue « Modifier le projet », à
 * côté du bouton de réglages : deux portes pour régler une même chose. Le
 * dialogue ne sert plus qu'à CRÉER un projet, geste qui n'a pas d'élément à
 * viser, et le seul où le niveau de confidentialité se choisit.
 *
 * Le profil est de la donnée chiffrée et la coquille ne tient pas le
 * déverrouillage : chaque lecture et chaque écriture passe par `withSecrecy`,
 * qui ouvre l'invite sur un projet confidentiel verrouillé puis rejoue.
 *
 * Un projet projeté d'un autre espace se règle d'ici : son profil se réécrit
 * chez lui, et l'archiver le sort de toutes ses fenêtres à la fois. Ce qui
 * référence son espace d'origine (confidentialité, liaisons, suivi des
 * releases, classement) se règle là-bas.
 */
export default function ProjectGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const projectId = scope.kind === 'item' ? Number(scope.itemId) : null;
    // Le profil et l'archivage relèvent de « Gérer les projets », pas de la
    // seule écriture : c'est l'existence du projet qu'on touche ici.
    const permissions = useWorkspacePermissions();
    const canManage =
        canWrite && projectId !== null && permissions.canExtra('projects', 'manageProjects', String(projectId));
    const [project, setProject] = useState<Project | null>(null);
    const [draft, setDraft] = useState<ProjectDraft | null>(null);
    const [tagKind, setTagKind] = useState<ProjectTag['kind']>('tech');
    const [tagLabel, setTagLabel] = useState('');
    const [iconError, setIconError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (projectId === null) return;
        void (async () => {
            try {
                const res = await withSecrecy(() => api.send('projects.get', { projectId }));
                setProject(res.project);
                setDraft(draftOf(res.project));
            } catch (e) {
                setError(humanizeError(e, 'Le projet n’a pas pu être lu.'));
            }
        })();
    }, [projectId]);

    const set = (change: Partial<ProjectDraft>) => setDraft((d) => (d ? { ...d, ...change } : d));

    const addTag = () => {
        if (!draft) return;
        const label = tagLabel.trim();
        if (!label || draft.tags.length >= PROJECT_MAX_TAGS) return;
        const exists = draft.tags.some((t) => t.kind === tagKind && t.label.toLowerCase() === label.toLowerCase());
        if (!exists) set({ tags: [...draft.tags, { kind: tagKind, label }] });
        setTagLabel('');
    };

    const removeTag = (index: number) => {
        if (!draft) return;
        set({ tags: draft.tags.filter((_, i) => i !== index) });
    };

    /**
     * Réduit l'image déposée et la pose dans le brouillon. Un échec laisse la
     * vignette en place et ne bloque rien : il s'affiche sous le titre.
     */
    const pickIcon = async (file: File | null) => {
        if (!file) return;
        try {
            const icon = await fileToSquareDataUrl(file, {
                size: PROJECT_ICON_SIZE,
                maxLength: PROJECT_ICON_MAX_LENGTH
            });
            set({ icon });
            setIconError(null);
        } catch (e) {
            setIconError(e instanceof Error ? e.message : 'Image refusée.');
        }
    };

    const save = async () => {
        if (!project || !draft || busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await withSecrecy(() =>
                api.send('projects.update', {
                    projectId: project.id,
                    project: { ...draft, title: draft.title.trim() }
                })
            );
            setProject(res.project);
            setDraft(draftOf(res.project));
            // Le portefeuille et la fiche portent le titre et le statut ;
            // l'historique, le renommage.
            invalidate('projects.list', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const archive = async () => {
        if (!project) return;
        setBusy(true);
        setError(null);
        try {
            await withSecrecy(() => api.send('projects.archive', { projectId: project.id }));
            // La fiche s'en va AVANT que le portefeuille ne se relise : relue
            // après coup, elle chercherait un projet qui l'a quitté.
            gone();
            invalidate('projects.list', 'projects.count');
        } catch (e) {
            setError(humanizeError(e, 'L’archivage a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (!project || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const editable = canManage && !busy;
    const name = project.title || 'Sans titre';

    return (
        <div className={shell.section}>
            {/* Le choix de l'image et le titre sur une même ligne : les deux
                nomment le projet. L'image est réduite dans le navigateur avant
                d'être envoyée, le contrat borne la charge utile. */}
            <div className={styles.iconRow}>
                <button
                    type='button'
                    className={styles.iconPicker}
                    disabled={!editable}
                    onClick={() => fileRef.current?.click()}
                    title='Choisir une image'
                    aria-label='Choisir une vignette pour le projet'
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
                    <span className={shell.sectionLabel}>Titre</span>
                    <TextInput
                        value={draft.title}
                        maxLength={PROJECT_TITLE_MAX_LENGTH}
                        placeholder='Nom du projet'
                        disabled={!editable}
                        onChange={(e) => set({ title: e.target.value })}
                    />
                    <span className={iconError ? shell.errorText : shell.fieldHint}>
                        {iconError ??
                            (draft.icon
                                ? 'Cliquez sur la vignette pour la remplacer.'
                                : 'Cliquez sur la vignette pour choisir une image (PNG, JPEG ou WebP).')}
                    </span>
                </label>

                {draft.icon && editable && (
                    <Button variant='ghost' onClick={() => set({ icon: '' })}>
                        Retirer
                    </Button>
                )}
            </div>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Description</span>
                <textarea
                    className={styles.textarea}
                    value={draft.description}
                    rows={4}
                    disabled={!editable}
                    placeholder='À quoi sert ce projet ?'
                    onChange={(e) => set({ description: e.target.value })}
                />
            </label>

            {/* `styles.field` et non `shell.field` : dans une rangée, les champs
                se partagent la largeur, ce que la feuille de la coquille ne
                prévoit pas. */}
            <div className={styles.row}>
                <label className={styles.field}>
                    <span className={shell.sectionLabel}>Statut</span>
                    <SelectInput
                        value={draft.status}
                        disabled={!editable}
                        onChange={(e) => set({ status: e.target.value as ProjectStatus })}
                    >
                        {STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                            </option>
                        ))}
                    </SelectInput>
                </label>
                <label className={styles.field}>
                    <span className={shell.sectionLabel}>Début</span>
                    <TextInput
                        type='date'
                        value={dateInputValue(draft.startDate)}
                        disabled={!editable}
                        onChange={(e) => set({ startDate: dateInputToSeconds(e.target.value) })}
                    />
                </label>
                <label className={styles.field}>
                    <span className={shell.sectionLabel}>Échéance</span>
                    <TextInput
                        type='date'
                        value={dateInputValue(draft.dueDate)}
                        disabled={!editable}
                        onChange={(e) => set({ dueDate: dateInputToSeconds(e.target.value) })}
                    />
                </label>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Étiquettes</span>
                <div className={styles.tagRow}>
                    <SelectInput
                        value={tagKind}
                        disabled={!editable}
                        aria-label='Famille de l’étiquette'
                        onChange={(e) => setTagKind(e.target.value as ProjectTag['kind'])}
                    >
                        <option value='type'>{TAG_KIND_LABELS.type}</option>
                        <option value='tech'>{TAG_KIND_LABELS.tech}</option>
                    </SelectInput>
                    <TextInput
                        value={tagLabel}
                        maxLength={PROJECT_TAG_LABEL_MAX_LENGTH}
                        placeholder={tagKind === 'type' ? 'site web, app mobile…' : 'react, express…'}
                        disabled={!editable}
                        aria-label='Nouvelle étiquette'
                        onChange={(e) => setTagLabel(e.target.value)}
                    />
                    <Button variant='secondary' onClick={addTag} disabled={!editable || !tagLabel.trim()}>
                        Ajouter
                    </Button>
                </div>
                {draft.tags.length > 0 && (
                    <ul className={styles.tags}>
                        {draft.tags.map((tag, i) => (
                            <li key={`${tag.kind}:${tag.label}`} className={styles.tag} data-kind={tag.kind}>
                                {tag.label}
                                {editable && (
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Retirer ${tag.label}`}
                                        onClick={() => removeTag(i)}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <Switch
                checked={draft.showTimeline}
                disabled={!editable}
                label='Afficher la frise'
                hint='Les tâches datées posées sur le temps, avec les jalons et les dépendances. Les dates restent sur les tâches quand elle est retirée.'
                onChange={(showTimeline) => set({ showTimeline })}
            />

            <Switch
                checked={draft.showOverview}
                disabled={!editable}
                label='Afficher la vue d’ensemble'
                hint='Un résumé du projet : avancement, échéances, charge de chacun. Retirée, ses indicateurs sur mesure restent enregistrés.'
                onChange={(showOverview) => set({ showOverview })}
            />

            {canManage ? (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={save} disabled={busy || !draft.title.trim()} />
                </div>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un projet : cela relève de la permission « Gérer les projets »
                    sur Projets.
                </ReadOnlyNotice>
            )}

            {project.foreign && (
                <p className={shell.sectionHint}>
                    Ce projet appartient à un autre espace qui le partage ici : son profil s’écrit chez lui, et ce qui
                    référence cet espace (confidentialité, liaisons, suivi des releases, classement) se règle là-bas.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            {/* Réversible d'un clic depuis les archives : une confirmation au
                ton ordinaire, pas celui d'une suppression. */}
            {canManage && !project.archived && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Archiver ce projet</span>
                    <span className={shell.fieldHint}>
                        Il quitte le portefeuille
                        {project.foreign && ', ici comme dans son espace d’origine,'} et rejoint les archives, d’où il
                        se restaure d’un clic. Rien n’est supprimé : dans ce module, rien ne l’est jamais.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='secondary'
                            icon='archive'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Archiver « ${name} » ?`,
                                    description:
                                        'Le projet quitte le portefeuille et rejoint les archives, d’où il se restaure d’un clic.',
                                    confirmLabel: 'Archiver',
                                    tone: 'primary',
                                    onConfirm: () => void archive()
                                })
                            }
                        >
                            Archiver le projet
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
