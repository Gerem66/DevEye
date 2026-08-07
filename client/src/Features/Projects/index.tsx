import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectSummary } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { useLiveSegment } from '@/live/useLiveSegment';
import { useLiveOutlines } from '@/live/useLiveOutline';
import type { FeatureProps } from '@/Features/types';
import { formatDate, humanizeError, STATUS_LABELS, withSecrecy } from './api';
import ProjectDialog, { type ProjectDialogResult } from './ProjectDialog';
import ProjectDetail from './ProjectDetail';
import MyTasks from './MyTasks';
import styles from './style.module.css';

/**
 * Projets — le portefeuille de l'espace actif.
 *
 * Pas de routeur dans ce client : la navigation interne est une machine à états
 * locale. Cette première vue liste les projets ; le détail (kanban, frise,
 * discussion, git, déploiement) s'y greffera par un identifiant sélectionné.
 *
 * Le portefeuille ne demande **jamais** de mot de passe : `project.list` ne lit
 * que l'étage ouvert et renvoie les projets confidentiels masqués. Seule
 * l'ouverture ou l'édition de l'un d'eux passe par `withSecrecy`.
 */
export function FeatureProjects({ user, workspace }: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('projects', 'write');

    const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const [showMine, setShowMine] = useState(false);

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<Project | null>(null);
    /** Le projet ouvert en vue détail ; `null` = on est sur le portefeuille. */
    const [opened, setOpened] = useState<Project | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);

    const version = useResourceVersion('project.list');
    const reloadRef = useRef<Promise<void> | null>(null);

    // Présence : « qui regarde quel projet ». Un seul déclarant par niveau —
    // ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
    useLiveSegment('l1', selectedId === null ? null : `project:${selectedId}`);
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const res = await ws.send('project.list', { archived: showArchived });
                setSummaries(res.projects);
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les projets.'));
            }
        })();
        reloadRef.current = task;
        try {
            await task;
        } finally {
            reloadRef.current = null;
        }
    }, [showArchived]);

    useEffect(() => {
        setSummaries(null);
        void reload();
        // `version` rejoue l'effet quand la ressource est invalidée — par notre
        // propre écriture, ou par `live.changed` venu d'un autre membre.
    }, [reload, workspace.id, version]);

    const openCreate = () => {
        setEditing(null);
        setDialogError(null);
        setDialogOpen(true);
    };

    /** Charge le projet en entier — c'est ici que l'invite peut apparaître. */
    const fetchProject = async (projectId: number): Promise<Project | null> => {
        try {
            const res = await withSecrecy(() => ws.send('project.get', { projectId }));
            return res.project;
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’ouvrir ce projet.'));
            return null;
        }
    };

    /** Ouvre le projet : sa vue détail (tableau, et bientôt les autres onglets). */
    const openProject = async (summary: ProjectSummary) => {
        const project = await fetchProject(summary.project.id);
        if (!project) return;
        setOpened(project);
        setSelectedId(project.id);
    };

    /** Ouvre le formulaire de profil, depuis la liste ou depuis le détail. */
    const openEdit = async (projectId: number) => {
        const project = await fetchProject(projectId);
        if (!project) return;
        setEditing(project);
        setDialogError(null);
        setDialogOpen(true);
    };

    const submit = async ({ draft, securityTier }: ProjectDialogResult) => {
        setBusy(true);
        setDialogError(null);
        try {
            const res = await withSecrecy(() =>
                editing
                    ? ws.send('project.update', { projectId: editing.id, project: draft })
                    : ws.send('project.add', { project: draft, securityTier })
            );
            // Invalider à la source de la mutation : la tuile d'accueil lit
            // `project.count`, la liste lit `project.list`.
            invalidate('project.list', 'project.count');
            // Le détail affiche le titre et le statut : il doit suivre l'édition.
            if (opened && opened.id === res.project.id) setOpened(res.project);
            setDialogOpen(false);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const setArchived = async (summary: ProjectSummary, archived: boolean) => {
        try {
            await withSecrecy(() =>
                archived
                    ? ws.send('project.archive', { projectId: summary.project.id })
                    : ws.send('project.restore', { projectId: summary.project.id })
            );
            invalidate('project.list', 'project.count');
        } catch (e) {
            setError(humanizeError(e, archived ? 'L’archivage a échoué.' : 'La restauration a échoué.'));
        }
    };

    const totals = useMemo(() => {
        if (!summaries) return null;
        return {
            count: summaries.length,
            overdue: summaries.reduce((n, s) => n + s.cardOverdue, 0),
            unread: summaries.reduce((n, s) => n + s.unread, 0)
        };
    }, [summaries]);

    // Vue détail : le portefeuille cède la place, mais reste monté derrière —
    // le retour est alors instantané et sans re-sollicitation.
    if (opened) {
        return (
            <>
                <ProjectDetail
                    project={opened}
                    members={workspace.users}
                    meUserId={user.id}
                    canWrite={canWrite}
                    onBack={() => {
                        setOpened(null);
                        setSelectedId(null);
                    }}
                    onEditProfile={() => void openEdit(opened.id)}
                />
                <ProjectDialog
                    open={dialogOpen}
                    project={editing}
                    allowGuarded={workspace.kind === 'personal'}
                    busy={busy}
                    error={dialogError}
                    onClose={() => setDialogOpen(false)}
                    onSubmit={(result) => void submit(result)}
                />
            </>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div>
                    <h2 className={styles.heading}>
                        {showMine ? 'Mes tâches' : showArchived ? 'Projets archivés' : 'Portefeuille'}
                    </h2>
                    {totals && !showArchived && !showMine && (
                        <p className={styles.subheading}>
                            {totals.count} projet{totals.count > 1 ? 's' : ''}
                            {totals.overdue > 0 &&
                                ` · ${totals.overdue} tâche${totals.overdue > 1 ? 's' : ''} en retard`}
                            {totals.unread > 0 &&
                                ` · ${totals.unread} message${totals.unread > 1 ? 's' : ''} non lu${totals.unread > 1 ? 's' : ''}`}
                        </p>
                    )}
                </div>
                <div className={styles.actions}>
                    {/* Rien ne se supprime : l'archive est le seul chemin de
                        sortie, elle doit donc aussi être un chemin de retour. */}
                    {/* Bascule, pas un onglet : « mes tâches » est une lecture
                        du même portefeuille, sous un autre angle. */}
                    <Button
                        variant={showMine ? 'primary' : 'secondary'}
                        icon='user'
                        onClick={() => {
                            setShowMine((v) => !v);
                            setShowArchived(false);
                        }}
                    >
                        Mes tâches
                    </Button>
                    <Button
                        variant='secondary'
                        icon='archive'
                        onClick={() => {
                            setShowArchived((v) => !v);
                            setShowMine(false);
                        }}
                    >
                        {showArchived ? 'Retour au portefeuille' : 'Archives'}
                    </Button>
                    {canWrite && !showArchived && !showMine && (
                        <Button icon='add' onClick={openCreate}>
                            Nouveau projet
                        </Button>
                    )}
                </div>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {showMine && (
                <MyTasks
                    onOpenProject={(projectId) => {
                        const summary = summaries?.find((s) => s.project.id === projectId);
                        if (summary) void openProject(summary);
                    }}
                />
            )}

            {!showMine && summaries === null && <p className={styles.empty}>Chargement…</p>}

            {!showMine && summaries?.length === 0 && (
                <p className={styles.empty}>
                    {showArchived
                        ? 'Aucun projet archivé.'
                        : `Aucun projet pour l’instant.${canWrite ? ' Créez-en un pour commencer à suivre son avancement.' : ''}`}
                </p>
            )}

            {!showMine && summaries && summaries.length > 0 && (
                <ul className={styles.grid}>
                    {summaries.map((summary) => (
                        <ProjectCard
                            key={summary.project.id}
                            summary={summary}
                            canWrite={canWrite}
                            archived={showArchived}
                            outline={outlineFor(`project:${summary.project.id}`)}
                            onOpen={() => void openProject(summary)}
                            onArchive={() => void setArchived(summary, !showArchived)}
                        />
                    ))}
                </ul>
            )}

            <ProjectDialog
                open={dialogOpen}
                project={editing}
                allowGuarded={workspace.kind === 'personal'}
                busy={busy}
                error={dialogError}
                onClose={() => setDialogOpen(false)}
                onSubmit={(result) => void submit(result)}
            />
        </div>
    );
}

interface ProjectCardProps {
    summary: ProjectSummary;
    canWrite: boolean;
    /** La carte est rendue depuis la vue des archives : l'action est un retour. */
    archived: boolean;
    outline: ReturnType<ReturnType<typeof useLiveOutlines>>;
    onOpen: () => void;
    onArchive: () => void;
}

function ProjectCard({ summary, canWrite, archived, outline, onOpen, onArchive }: ProjectCardProps) {
    const { project, masked, cardTotal, cardDone, cardOverdue, nextDueDate, unread } = summary;
    const progress = cardTotal === 0 ? 0 : Math.round((cardDone / cardTotal) * 100);
    const due = formatDate(nextDueDate);

    return (
        <li className={styles.card} {...outline}>
            <button type='button' className={styles.cardBody} onClick={onOpen}>
                <div className={styles.cardTop}>
                    <span className={styles.status} data-status={project.status}>
                        {STATUS_LABELS[project.status]}
                    </span>
                    {project.securityTier === 'guarded' && (
                        <span className={styles.lock} title='Projet confidentiel'>
                            <span className='icon icon-lock' />
                        </span>
                    )}
                    {/* Badge visible uniquement s'il y a réellement du non-lu. */}
                    {unread > 0 && <span className={styles.unread}>{unread}</span>}
                </div>

                <h3 className={styles.title}>
                    {masked ? (
                        <span className={styles.masked}>Projet confidentiel</span>
                    ) : (
                        project.title || 'Sans titre'
                    )}
                </h3>

                {!masked && project.description && <p className={styles.description}>{project.description}</p>}

                {!masked && project.tags.length > 0 && (
                    <ul className={styles.tags}>
                        {project.tags.map((tag) => (
                            <li key={`${tag.kind}:${tag.label}`} className={styles.tag} data-kind={tag.kind}>
                                {tag.label}
                            </li>
                        ))}
                    </ul>
                )}

                <div className={styles.progress} aria-label={`Avancement ${progress}%`}>
                    <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                </div>
                <div className={styles.meta}>
                    <span>
                        {cardDone}/{cardTotal} tâche{cardTotal > 1 ? 's' : ''}
                    </span>
                    {cardOverdue > 0 && <span className={styles.overdue}>{cardOverdue} en retard</span>}
                    {due && <span>échéance {due}</span>}
                    {!masked && project.version && <span className={styles.version}>v{project.version}</span>}
                </div>
            </button>

            {canWrite && (
                <button
                    type='button'
                    className={archived ? styles.restore : styles.archive}
                    title={archived ? 'Restaurer' : 'Archiver'}
                    aria-label={`${archived ? 'Restaurer' : 'Archiver'} ${project.title || 'ce projet'}`}
                    onClick={onArchive}
                >
                    <span className={archived ? 'icon icon-refresh' : 'icon icon-archive'} />
                </button>
            )}
        </li>
    );
}

export default FeatureProjects;
