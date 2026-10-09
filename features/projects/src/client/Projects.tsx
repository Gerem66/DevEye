import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
    Button,
    CountBadge,
    humanizeError,
    invalidate,
    StatusBadge,
    StickyHeader,
    useActiveWorkspace,
    useCurrentUser,
    useDragReorder,
    useLiveOutlines,
    useLiveSegment,
    useResourceVersion,
    useSubView,
    useWorkspaceMembers,
    useWorkspacePermissions,
    withSecrecy
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import { api, formatDate, STATUS_LABELS } from './api';
import type { Project, ProjectSummary } from '../contracts/domain';
import ProjectDialog, { type ProjectDialogResult } from './ProjectDialog';
import ProjectDetail from './ProjectDetail';
import MyTasks from './MyTasks';
import styles from './style.module.css';

/**
 * Les projets projetés depuis un autre espace viennent après les locaux : leur
 * rang est celui de leur domicile, et le serveur refuse un ordre qui les inclut.
 * Le tri est stable, l'ordre du serveur demeure dans chaque moitié.
 */
function byHome(a: ProjectSummary, b: ProjectSummary): number {
    return Number(a.foreign) - Number(b.foreign);
}

/**
 * Le portefeuille de l'espace actif. Pas de routeur ici : la navigation interne
 * est une machine à états locale, le détail se greffe par un identifiant
 * sélectionné. Ne demande jamais de mot de passe, `projects.list` ne lit que
 * l'étage ouvert ; seules l'ouverture et la création passent par `withSecrecy`.
 * Le profil d'un projet se règle dans l'onglet Général de sa fiche.
 */
export function FeatureProjects(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    /**
     * Le portefeuille est le seul écran hors d'un projet : ses gestes (créer,
     * ranger, archiver) relèvent tous de « Gérer les projets », et se lisent à
     * l'échelle de la fonctionnalité : une surcharge posée sur un projet ne dit
     * rien de la création du suivant. L'archivage d'une carte, lui, vise un
     * projet et se lit sur lui.
     */
    const canManage = permissions.canFeature('projects', 'write') && permissions.canExtra('projects', 'manageProjects');
    const canManageOn = (id: number) =>
        permissions.canFeature('projects', 'write', String(id)) &&
        permissions.canExtra('projects', 'manageProjects', String(id));
    const workspace = useActiveWorkspace();
    const workspaceId = workspace?.id ?? null;
    /** Un espace partagé n'accepte pas le tier confidentiel (voir `ProjectDialog`). */
    const allowGuarded = workspace?.kind === 'personal';
    const members = useWorkspaceMembers();
    const me = useCurrentUser();

    const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const [showMine, setShowMine] = useState(false);

    const [dialogOpen, setDialogOpen] = useState(false);
    /** Le projet ouvert en vue détail ; `null` = on est sur le portefeuille. */
    const [opened, setOpened] = useState<Project | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);

    const version = useResourceVersion('projects.list');
    const reloadRef = useRef<Promise<void> | null>(null);
    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    // Présence « qui regarde quel projet » : un seul déclarant par niveau, ce
    // composant possède `l1`.
    const liveTarget = useLiveSegment('l1', selectedId === null ? null : String(selectedId));
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const res = await api.send('projects.list', { archived: showArchived });
                setSummaries([...res.projects].sort(byHome));
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

    /**
     * Repartir de rien seulement quand l'écran change vraiment : vider la liste
     * dans l'effet de relecture la ferait clignoter à la moindre invalidation,
     * glisser-déposer compris.
     */
    useEffect(() => {
        setSummaries(null);
    }, [workspaceId, showArchived]);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un
        // glissé. Elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        void reload();
    }, [reload, workspaceId, version]);

    /**
     * La fiche affiche le titre, le statut et la version : elle suit une édition
     * faite dans ses réglages (onglet Général) ou ailleurs, qui ravive
     * `projects.list`. Sur `updated` et non à chaque relecture : le fil de
     * discussion ravive la liste à chaque message pour ses non-lus. Un projet
     * masqué n'a rien à donner.
     */
    useEffect(() => {
        if (!summaries) return;
        setOpened((prev) => {
            if (!prev) return prev;
            const fresh = summaries.find((s) => !s.masked && s.project.id === prev.id);
            return fresh && fresh.project.updated !== prev.updated ? fresh.project : prev;
        });
    }, [summaries]);

    const onDragStateChange = useCallback(
        (active: boolean) => {
            dragging.current = active;
            if (!active && pendingReload.current) {
                pendingReload.current = false;
                void reload();
            }
        },
        [reload]
    );

    /**
     * L'ordre est posé localement d'abord : la carte reste là où on l'a lâchée.
     * `projects.reorder` ne touche pas au corps chiffré, un portefeuille de
     * projets confidentiels se range sans rien déverrouiller. `ids` ne compte que
     * les projets locaux, les projetés gardent leur place en queue.
     */
    const reorder = useCallback(
        (ids: number[]) => {
            setSummaries((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((s) => [s.project.id, s]));
                return [...ids.flatMap((id) => byId.get(id) ?? []), ...prev.filter((s) => s.foreign)];
            });
            // Relue d'abord : son succès efface l'erreur affichée.
            api.send('projects.reorder', { projectIds: ids }).catch(() => {
                void reload().then(() => setError('Réorganisation impossible.'));
            });
        },
        [reload]
    );

    const openCreate = () => {
        setDialogError(null);
        setDialogOpen(true);
    };

    /** Charge le projet en entier : c'est ici que l'invite peut apparaître. */
    const fetchProject = useCallback(async (projectId: number): Promise<Project | null> => {
        try {
            const res = await withSecrecy(() => api.send('projects.get', { projectId }));
            return res.project;
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’ouvrir ce projet.'));
            return null;
        }
    }, []);

    /**
     * Mémoïsée parce que l'effet de téléportation en dépend : recréée à chaque
     * rendu, elle le ferait rejouer en boucle tant qu'une cible est posée.
     */
    const openProject = useCallback(
        async (summary: ProjectSummary) => {
            const project = await fetchProject(summary.project.id);
            if (!project) return;
            setOpened(project);
            setSelectedId(project.id);
        },
        [fetchProject]
    );

    const create = async ({ draft, securityTier }: ProjectDialogResult) => {
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(() => api.send('projects.add', { project: draft, securityTier }));
            invalidate('projects.list', 'projects.count');
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
                    ? api.send('projects.archive', { projectId: summary.project.id })
                    : api.send('projects.restore', { projectId: summary.project.id })
            );
            invalidate('projects.list', 'projects.count');
        } catch (e) {
            setError(humanizeError(e, archived ? 'L’archivage a échoué.' : 'La restauration a échoué.'));
        }
    };

    /**
     * Où une téléportation veut nous emmener : rejoindre quelqu'un qui regarde un
     * projet, ou le « ouvrir le projet » de Git, qui pose le même chemin
     * `view:projects l1:<id>`. La cible reste posée tant qu'elle n'est pas
     * atteinte, l'effet la retrouvera au rendu suivant sans rien acquitter.
     */
    useEffect(() => {
        if (!liveTarget) return;
        if (liveTarget.value === null) {
            // Le niveau doit être refermé : on remonte au portefeuille.
            setOpened(null);
            setSelectedId(null);
            return;
        }
        const id = Number(liveTarget.value.replace(/^project:/, ''));
        if (!Number.isFinite(id) || id === selectedId) return;
        const summary = summaries?.find((s) => s.project.id === id);
        if (!summary) return;
        void openProject(summary);
    }, [liveTarget, summaries, selectedId, openProject]);

    /** Les projets projetés du portefeuille : « Mes tâches » les signale. */
    const foreignIds = useMemo(
        () => new Set(summaries?.flatMap((s) => (s.foreign ? [s.project.id] : [])) ?? []),
        [summaries]
    );

    const totals = useMemo(() => {
        if (!summaries) return null;
        return {
            count: summaries.length,
            overdue: summaries.reduce((n, s) => n + s.cardOverdue, 0),
            unread: summaries.reduce((n, s) => n + s.unread, 0)
        };
    }, [summaries]);

    /**
     * « Mes tâches » et les archives sont des écrans à part et non des filtres :
     * on en sort par le retour en tête de page, pas par la bascule qui y a mené,
     * et ils n'ont pas d'actions à droite.
     */
    const sideView = showMine || showArchived;
    useSubView(opened ? 'project' : showMine ? 'my-tasks' : showArchived ? 'archived' : null);

    /**
     * Ranger n'a de sens que sur le portefeuille vivant : les archives se lisent
     * dans l'ordre d'archivage, et un ordre manuel n'y survivrait pas à la
     * restauration, qui renvoie en fin de liste.
     */
    const canReorder = canManage && !sideView;

    // Les projets projetés en sont exclus de bout en bout : pas de poignée,
    // absents de l'ordre envoyé (le serveur le refuse) et de `data-project-card`.
    // Rangés en queue, ils n'occupent aucun interstice qu'un dépôt puisse viser.
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: summaries?.flatMap((s) => (s.foreign ? [] : [s.project.id])) ?? [],
        rowSelector: '[data-project-card]',
        layout: 'grid',
        onReorder: (ids) => reorder(ids as number[]),
        onDragStateChange
    });

    // La session livre l'utilisateur avant qu'une feature ne se monte : le
    // `null` est un cas du type, pas un état de l'écran.
    if (me === null) return null;

    // Vue détail : le portefeuille cède la place, son état reste en mémoire donc
    // le retour est instantané et sans re-sollicitation.
    if (opened) {
        return (
            <ProjectDetail
                project={opened}
                members={members}
                meUserId={me.id}
                onBack={() => {
                    setOpened(null);
                    setSelectedId(null);
                }}
            />
        );
    }

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={sideView ? styles.detailHead : undefined}>
                        {sideView && (
                            <Button
                                variant='ghost'
                                icon='arrow-left'
                                onClick={() => {
                                    setShowMine(false);
                                    setShowArchived(false);
                                }}
                            >
                                Retour
                            </Button>
                        )}
                        <div>
                            <h2 className={styles.heading}>
                                {showMine ? 'Mes tâches' : showArchived ? 'Projets archivés' : 'Projets'}
                            </h2>
                            {totals && !sideView && (
                                <p className={styles.subheading}>
                                    {totals.count} projet{totals.count > 1 ? 's' : ''}
                                    {totals.overdue > 0 &&
                                        ` · ${totals.overdue} tâche${totals.overdue > 1 ? 's' : ''} en retard`}
                                    {totals.unread > 0 &&
                                        ` · ${totals.unread} message${totals.unread > 1 ? 's' : ''} non lu${totals.unread > 1 ? 's' : ''}`}
                                </p>
                            )}
                        </div>
                    </div>

                    {!sideView && (
                        <div className={styles.actions}>
                            <Button variant='secondary' onClick={() => setShowMine(true)}>
                                <span className='icon icon-user' />
                                Mes tâches
                            </Button>

                            <Button variant='secondary' onClick={() => setShowArchived(true)}>
                                <span className='icon icon-archive' />
                                Archives
                            </Button>

                            {canManage && (
                                <Button icon='add' onClick={openCreate}>
                                    Nouveau projet
                                </Button>
                            )}
                        </div>
                    )}
                </header>
            </StickyHeader>

            {error && <p className={styles.error}>{error}</p>}

            {showMine && (
                <MyTasks
                    foreignProjectIds={foreignIds}
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
                        : `Aucun projet pour l’instant.${canManage ? ' Créez-en un pour commencer à suivre son avancement.' : ''}`}
                </p>
            )}

            {!showMine && summaries && summaries.length > 0 && (
                <ul ref={drag.listRef} className={styles.grid}>
                    {summaries.map((summary) => (
                        <ProjectCard
                            key={summary.project.id}
                            summary={summary}
                            canManage={canManageOn(summary.project.id)}
                            archived={showArchived}
                            outline={outlineFor(String(summary.project.id))}
                            dragging={drag.draggingId === summary.project.id}
                            onOpen={() => void openProject(summary)}
                            onArchive={() => void setArchived(summary, !showArchived)}
                            onDragPointerDown={
                                canReorder && !summary.foreign
                                    ? (e) => drag.onGripPointerDown(e, summary.project.id)
                                    : undefined
                            }
                        />
                    ))}
                    {/* Un `<li>`, seul enfant valide d'une `<ul>`. Sorti du flux
                        en absolu, il n'occupe aucune cellule. */}
                    <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
                </ul>
            )}

            <ProjectDialog
                open={dialogOpen}
                allowGuarded={allowGuarded}
                busy={busy}
                error={dialogError}
                onClose={() => setDialogOpen(false)}
                onSubmit={(result) => void create(result)}
            />
        </div>
    );
}

interface ProjectCardProps {
    summary: ProjectSummary;
    /** Archiver et restaurer ce projet-ci. */
    canManage: boolean;
    /** La carte est rendue depuis la vue des archives : l'action est un retour. */
    archived: boolean;
    outline: ReturnType<ReturnType<typeof useLiveOutlines>>;
    /** Cette carte est celle qu'on déplace : elle s'estompe sur place. */
    dragging: boolean;
    onOpen: () => void;
    onArchive: () => void;
    /** Absent = pas de poignée : ranger est une écriture, et non dans les archives. */
    onDragPointerDown?: (e: ReactPointerEvent) => void;
}

function ProjectCard({
    summary,
    canManage,
    archived,
    outline,
    dragging,
    onOpen,
    onArchive,
    onDragPointerDown
}: ProjectCardProps) {
    const { project, masked, foreign, cardTotal, cardDone, cardOverdue, nextDueDate, unread } = summary;
    const progress = cardTotal === 0 ? 0 : Math.round((cardDone / cardTotal) * 100);
    const due = formatDate(nextDueDate);

    return (
        // `data-project-card` marque une rangée que le glisser-classer peut
        // viser : un projet projeté n'en est pas une.
        <li
            className={`${styles.card} ${dragging ? styles.cardDragging : ''}`}
            data-project-card={foreign ? undefined : ''}
            {...outline}
        >
            {/* La poignée est sœur du corps cliquable et non son enfant : un clic
                parti d'ici ne remonte pas jusqu'à « ouvrir le projet ». */}
            {onDragPointerDown && (
                <button
                    type='button'
                    className={styles.grip}
                    aria-label={`Réordonner ${masked ? 'ce projet' : project.title || 'ce projet'}`}
                    onPointerDown={onDragPointerDown}
                >
                    <span className='icon icon-drag' />
                </button>
            )}

            {/* `div role="button"` et non `<button>` : la carte contient du
                contenu de flux (titre, paragraphe, liste d'étiquettes), interdit
                dans un bouton dont le modèle de contenu est phrasé. */}
            <div
                className={styles.cardBody}
                role='button'
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen();
                    }
                }}
            >
                {/* Vignette masquée sur un projet verrouillé, comme le titre :
                    une image identifie autant qu'un nom. */}
                <span className={styles.cardIcon} aria-hidden='true'>
                    {!masked && project.icon ? (
                        <img src={project.icon} alt='' />
                    ) : (
                        <span className='icon icon-projects' />
                    )}
                </span>

                <div className={styles.cardIdent}>
                    <div className={styles.cardTitleRow}>
                        <span className={styles.status} data-status={project.status}>
                            {STATUS_LABELS[project.status]}
                        </span>
                        {project.securityTier === 'guarded' && (
                            <span className={styles.lock} title='Projet confidentiel'>
                                <span className='icon icon-lock' />
                            </span>
                        )}
                        {/* Sans cette pastille, rien ne distinguerait une ligne
                            locale d'une fenêtre sur l'espace voisin. */}
                        {foreign && (
                            <span
                                className={styles.shared}
                                title='Ce projet appartient à un autre espace qui le partage ici'
                            >
                                <StatusBadge tone='accent'>partagé</StatusBadge>
                            </span>
                        )}

                        <h3 className={styles.title}>
                            {masked ? (
                                <span className={styles.masked}>Projet confidentiel</span>
                            ) : (
                                project.title || 'Sans titre'
                            )}
                        </h3>

                        {!masked && project.tags.length > 0 && (
                            <ul className={styles.tags}>
                                {project.tags.map((tag) => (
                                    <li key={`${tag.kind}:${tag.label}`} className={styles.tag} data-kind={tag.kind}>
                                        {tag.label}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {!masked && project.description && <p className={styles.description}>{project.description}</p>}
                </div>

                <div className={styles.cardProgress}>
                    <div className={styles.meta}>
                        <span className={styles.metaLeft}>
                            {cardOverdue > 0 && <span className={styles.overdue}>{cardOverdue} en retard</span>}
                            {due && <span>échéance {due}</span>}
                            {!masked && project.version && <span className={styles.version}>v{project.version}</span>}
                        </span>
                        <span>
                            {cardDone}/{cardTotal} tâche{cardTotal > 1 ? 's' : ''}
                        </span>
                    </div>
                    <div className={styles.progress} aria-label={`Avancement ${progress}%`}>
                        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                    </div>
                </div>

                <div className={styles.cardAside}>
                    {unread > 0 && (
                        <CountBadge
                            count={unread}
                            aria-label={`${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}`}
                        />
                    )}

                    {/* Symbole et non bouton : il dit que toute la ligne est
                        cliquable. */}
                    <span className={styles.openArrow} aria-hidden='true'>
                        <span className='icon icon-arrow' />
                    </span>
                </div>
            </div>

            {/* Dans les archives, restaurer est le seul geste de l'écran : il
                reste à découvert sur la carte. */}
            {canManage && archived && (
                <button
                    type='button'
                    className={styles.restore}
                    title='Restaurer'
                    aria-label={`Restaurer ${project.title || 'ce projet'}`}
                    onClick={onArchive}
                >
                    <span className='icon icon-refresh' />
                </button>
            )}
        </li>
    );
}

export default FeatureProjects;
