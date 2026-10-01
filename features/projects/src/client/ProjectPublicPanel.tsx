import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    copyText,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    openAccountView,
    PageLookFields,
    PlanPausedBadge,
    PlanPausedNotice,
    ReadOnlyNotice,
    safeHref,
    SaveButton,
    SearchSelect,
    settingsStyles as shell,
    Switch,
    TextInput,
    useDomains,
    useResource,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';
import { resolvePageAccent } from '@deveye/types/sdk';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    PROJECT_SLUG_MAX_LENGTH,
    PROJECT_SLUG_PATTERN,
    PUBLIC_OWN_ACCENT,
    PUBLIC_PATH,
    PUBLIC_THEMES,
    type ProjectPublication,
    type ProjectPublicationDraft
} from '../contracts/domain';

import { api } from './api';
import PublicBoardPreview from './PublicBoardPreview';
import styles from './style.module.css';

function draftOf(publication: ProjectPublication | null): ProjectPublicationDraft {
    return {
        enabled: publication?.enabled ?? false,
        domainId: publication?.domainId ?? null,
        slug: null,
        showDates: publication?.showDates ?? false,
        showAssignees: publication?.showAssignees ?? false,
        showSubtasks: publication?.showSubtasks ?? false,
        theme: publication?.theme ?? 'auto',
        accent: publication?.accent ?? ''
    };
}

/**
 * La page publique du projet : son tableau, lisible sans compte, à un lien que
 * l'on donne à qui l'on veut. Un geste de qui gère le projet, réglé chez lui ;
 * un projet confidentiel ne se publie pas, le serveur n'en a pas la clé.
 */
export default function ProjectPublicPanel({ scope, canWrite }: SettingsPanelProps) {
    const projectId = scope.kind === 'item' ? Number(scope.itemId) : 0;
    const permissions = useWorkspacePermissions();
    const canManage = canWrite && permissions.canExtra('projects', 'manageProjects', String(projectId));
    const { data, error: loadError } = useResource(
        'projects.publication',
        () => api.send('projects.publication', { projectId }),
        'La page publique de ce projet n’a pas pu être lue.',
        [projectId]
    );
    const { domains } = useDomains('projects');
    const [draft, setDraft] = useState<ProjectPublicationDraft>(() => draftOf(null));
    const [slugText, setSlugText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<boolean | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const publication = data?.publication ?? null;
    useEffect(() => {
        setDraft(draftOf(publication));
        setSlugText(publication?.slug ?? '');
    }, [publication]);

    // Le domaine du projet reste proposé s'il retombe en attente : le taire
    // ferait croire qu'il n'est plus choisi.
    const offered = useMemo(
        () => domains.filter((domain) => domain.verifiedAt !== null || domain.id === publication?.domainId),
        [domains, publication]
    );
    const chosen = domains.find((domain) => domain.id === draft.domainId) ?? null;

    if (!data) {
        return <p className={loadError ? shell.notice : shell.empty}>{loadError ?? 'Chargement…'}</p>;
    }

    if (data.blocked === 'guarded') {
        return (
            <div className={shell.section}>
                <p className={shell.notice}>
                    Ce projet est confidentiel : il est chiffré par votre mot de passe, que le serveur n’a pas. Il ne
                    peut donc pas être montré au public.
                </p>
            </div>
        );
    }
    if (data.blocked === 'foreign') {
        return (
            <div className={shell.section}>
                <p className={shell.notice}>
                    Ce projet appartient à un autre espace qui le partage ici : sa page publique se règle dans son
                    espace d’origine.
                </p>
            </div>
        );
    }

    const editable = canManage && !busy;
    // 0 est une limite : l'offre n'en permet aucune. Une page déjà en ligne reste réglable.
    const closed = data.limit === 0 && !publication?.enabled;
    // Le chemin ne se choisit que là où il sert : sous un domaine dont un autre projet tient la racine.
    const showsPath =
        publication !== null &&
        draft.domainId !== null &&
        draft.domainId === publication.domainId &&
        !publication.atRoot;
    const slugTouched = showsPath && slugText.trim() !== (publication?.slug ?? '');
    const slugInvalid = slugTouched && !PROJECT_SLUG_PATTERN.test(slugText.trim());
    const pending = chosen !== null && chosen.verifiedAt === null;
    const accentInvalid = draft.accent !== '' && resolvePageAccent(draft.accent) === null;

    const save = async () => {
        if (!canManage || busy || slugInvalid || accentInvalid) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.publish', {
                projectId,
                publication: { ...draft, slug: slugTouched ? slugText.trim() : null }
            });
            invalidate('projects.publication');
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const relink = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.publicationRelink', { projectId });
            invalidate('projects.publication');
        } catch (e) {
            setError(humanizeError(e, 'Le lien n’a pas pu être changé.'));
        } finally {
            setBusy(false);
        }
    };

    /* `copyText` du SDK, et jamais `navigator.clipboard`, qui n'existe qu'en
       contexte sécurisé. Son échec se dit sur le bouton. */
    const copy = async (url: string) => {
        setCopied(await copyText(url));
        window.setTimeout(() => setCopied(null), 2500);
    };

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Donnez à qui vous voulez un lien vers le tableau de ce projet : il le consulte sans compte, en lecture
                seule, et le voit se mettre à jour tout seul. La discussion, l’historique et les tâches archivées n’en
                sortent jamais.
            </p>

            {publication?.planPaused && <PlanPausedNotice count={1} one='page publique' many='pages publiques' />}
            {closed && (
                <div className={styles.planNotice} role='status'>
                    <p>
                        L’offre de cet espace n’inclut pas de page publique pour les projets.
                        {!permissions.isOwner &&
                            ' L’offre est celle du propriétaire de l’espace : lui seul peut la changer.'}
                    </p>
                    {permissions.isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
                </div>
            )}

            <Switch
                checked={draft.enabled}
                disabled={!editable || (closed && !draft.enabled)}
                label='Page publique'
                hint='Fermée, son lien répond « page introuvable ». La rouvrir redonne le même lien.'
                onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />

            {publication?.enabled && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>
                        Adresse à partager {publication.planPaused && <PlanPausedBadge />}
                    </span>
                    <div className={styles.publicUrl}>
                        <a href={safeHref(publication.url)} target='_blank' rel='noopener noreferrer'>
                            {publication.url}
                        </a>
                        <button
                            type='button'
                            className={shell.rowAction}
                            title={
                                copied === null
                                    ? 'Copier le lien'
                                    : copied
                                      ? 'Lien copié'
                                      : 'Copie impossible : sélectionnez le lien à la main'
                            }
                            aria-label='Copier le lien de la page publique'
                            onClick={() => void copy(publication.url)}
                        >
                            <span className={`icon icon-${copied === true ? 'check-circle' : 'copy'}`} />
                        </button>
                    </div>
                    {publication.rootTitle !== null && (
                        <span className={shell.fieldHint}>
                            « {publication.rootTitle} » tient déjà la racine de ce domaine : ce projet y répond sous son
                            propre chemin.
                        </span>
                    )}
                </div>
            )}

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Domaine</span>
                <span className={shell.fieldWithAction}>
                    <SearchSelect
                        aria-label='Domaine de la page publique'
                        value={draft.domainId === null ? '' : String(draft.domainId)}
                        disabled={!editable}
                        onChange={(v) => setDraft((d) => ({ ...d, domainId: v === '' ? null : Number(v) }))}
                        options={[
                            { value: '', label: 'L’adresse de DevEye' },
                            ...offered.map((domain) => ({
                                value: String(domain.id),
                                label: domain.host,
                                detail: domain.verifiedAt === null ? 'en attente de vérification' : undefined
                            }))
                        ]}
                    />
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'projects' }}
                        initialSection='domains'
                        variant='ghost'
                        label='Gérer les domaines'
                    />
                </span>
                <span className={pending ? shell.warning : shell.fieldHint}>
                    {pending
                        ? `${chosen?.host ?? 'Ce domaine'} attend sa vérification : le lien reste sur l’adresse de DevEye d’ici là.`
                        : 'Un domaine à vous, comme roadmap.monentreprise.fr. Le premier projet publié dessus y répond directement ; les suivants, sous leur propre chemin. L’adresse de DevEye fonctionne toujours.'}
                </span>
            </div>

            {showsPath && chosen && (
                <label className={shell.field}>
                    <span className={shell.sectionLabel}>Chemin dans l’adresse</span>
                    <span className={styles.slugField}>
                        <span className={styles.slugPrefix}>{`${chosen.host}${PUBLIC_PATH}/`}</span>
                        <TextInput
                            value={slugText}
                            maxLength={PROJECT_SLUG_MAX_LENGTH}
                            disabled={!editable}
                            aria-invalid={slugInvalid}
                            onChange={(e) => setSlugText(e.target.value.toLowerCase())}
                        />
                    </span>
                    <span className={slugInvalid ? shell.errorText : shell.fieldHint}>
                        {slugInvalid
                            ? 'Des minuscules, des chiffres et des tirets, sans espace ni accent.'
                            : 'Le changer casse l’adresse déjà donnée.'}
                    </span>
                </label>
            )}

            <Switch
                checked={draft.showDates}
                disabled={!editable}
                label='Montrer les échéances et les jalons'
                hint='La date d’échéance de chaque tâche, en rouge quand elle est dépassée, et le jalon auquel elle appartient.'
                onChange={(showDates) => setDraft((d) => ({ ...d, showDates }))}
            />
            <Switch
                checked={draft.showAssignees}
                disabled={!editable}
                label='Montrer les personnes assignées'
                hint='Le nom des membres de l’espace assignés à chaque tâche, lisible par quiconque a le lien.'
                onChange={(showAssignees) => setDraft((d) => ({ ...d, showAssignees }))}
            />
            <Switch
                checked={draft.showSubtasks}
                disabled={!editable}
                label='Déplier les sous-tâches'
                hint='Un clic sur une tâche montre ses sous-tâches, faites ou non.'
                onChange={(showSubtasks) => setDraft((d) => ({ ...d, showSubtasks }))}
            />

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Apparence</span>
                <PageLookFields
                    theme={draft.theme}
                    accent={draft.accent}
                    themes={PUBLIC_THEMES}
                    ownAccent={PUBLIC_OWN_ACCENT}
                    disabled={!editable}
                    onChange={(look) => setDraft((d) => ({ ...d, theme: look.theme, accent: look.accent }))}
                    preview={<PublicBoardPreview theme={draft.theme} accent={draft.accent} />}
                />
                {accentInvalid && (
                    <span className={shell.errorText}>
                        Une couleur en hexadécimal s’écrit en six chiffres : #3a6ad6.
                    </span>
                )}
            </div>

            {canManage ? (
                <SaveButton onSave={save} disabled={busy || slugInvalid || accentInvalid} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de régler la page publique : cela relève de la permission « Gérer les
                    projets » sur Projets.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            {canManage && publication !== null && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Changer le lien</span>
                    <span className={shell.fieldHint}>
                        Le lien sous l’adresse de DevEye est remplacé, et l’ancien cesse aussitôt de répondre : à faire
                        si vous l’avez donné à quelqu’un qui ne doit plus voir ce tableau.
                        {publication.domainId !== null && ' L’adresse sous votre domaine, elle, ne change pas.'}
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='secondary'
                            icon='refresh'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: 'Changer le lien de la page publique ?',
                                    description:
                                        'L’ancien lien cesse aussitôt de répondre. Il faudra donner le nouveau à ceux qui doivent encore voir ce tableau.',
                                    confirmLabel: 'Changer le lien',
                                    tone: 'primary',
                                    onConfirm: () => void relink()
                                })
                            }
                        >
                            Changer le lien
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
