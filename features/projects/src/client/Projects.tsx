import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
    Button,
    humanizeError,
    invalidate,
    StatusBadge,
    useActiveWorkspace,
    useCurrentUser,
    useDragReorder,
    useLiveOutlines,
    useLiveSegment,
    useResourceVersion,
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
 * Les projets projetés depuis un autre espace viennent après les locaux.
 *
 * Leur rang est celui de leur domicile : les mêler au classement d'ici les
 * ferait paraître déplaçables, alors que le serveur refuse un ordre qui les
 * inclut. Le tri est stable : dans chaque moitié, l'ordre du serveur demeure.
 * Même parti que les notes.
 */
function byHome(a: ProjectSummary, b: ProjectSummary): number {
    return Number(a.foreign) - Number(b.foreign);
}

/**
 * Projets — le portefeuille de l'espace actif.
 *
 * Pas de routeur dans ce client : la navigation interne est une machine à états
 * locale. Cette première vue liste les projets ; le détail (kanban, frise,
 * discussion, git, déploiement) s'y greffera par un identifiant sélectionné.
 *
 * Le portefeuille ne demande **jamais** de mot de passe : `projects.list` ne lit
 * que l'étage ouvert et renvoie les projets confidentiels masqués. Seule
 * l'ouverture ou l'édition de l'un d'eux passe par `withSecrecy`.
 *
 * Depuis le rapatriement, l'espace vient de `useActiveWorkspace()`, ses
 * membres de `useWorkspaceMembers()` et l'appelant de `useCurrentUser()`, non
 * de props : la vue d'un module ne reçoit que `closeFeature`.
 */
export function FeatureProjects(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('projects', 'write');
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
    const [editing, setEditing] = useState<Project | null>(null);
    /** Le projet ouvert en vue détail ; `null` = on est sur le portefeuille. */
    const [opened, setOpened] = useState<Project | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);

    const version = useResourceVersion('projects.list');
    const reloadRef = useRef<Promise<void> | null>(null);
    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    // Présence : « qui regarde quel projet ». Un seul déclarant par niveau —
    // ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
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
     * Repartir de rien — mais seulement quand l'écran change vraiment.
     *
     * Vider la liste dans l'effet de relecture ferait clignoter tout le
     * portefeuille à la moindre invalidation, y compris celle que provoque notre
     * propre glisser-déposer : les cartes disparaîtraient sous le pointeur pour
     * revenir juste après. Changer d'espace ou passer aux archives, en revanche,
     * montre autre chose : là, « Chargement… » est la bonne réponse.
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
        // `version` rejoue l'effet quand la ressource est invalidée — par notre
        // propre écriture, ou par `live.changed` venu d'un autre membre.
    }, [reload, workspaceId, version]);

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
     * Ranger le portefeuille.
     *
     * L'ordre est posé localement d'abord : la carte reste là où on l'a lâchée,
     * sans attendre l'aller-retour. `projects.reorder` ne touche jamais au corps
     * chiffré — un portefeuille où dorment des projets confidentiels se range
     * donc sans rien déverrouiller.
     *
     * `ids` ne compte que les projets **locaux** : les projetés ne font pas
     * partie de l'ordre (voir `byHome`), ils gardent leur place en queue.
     */
    const reorder = useCallback(
        (ids: number[]) => {
            setSummaries((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((s) => [s.project.id, s]));
                return [...ids.flatMap((id) => byId.get(id) ?? []), ...prev.filter((s) => s.foreign)];
            });
            api.send('projects.reorder', { projectIds: ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    const openCreate = () => {
        setEditing(null);
        setDialogError(null);
        setDialogOpen(true);
    };

    /** Charge le projet en entier — c'est ici que l'invite peut apparaître. */
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
     * Ouvre le projet : sa vue détail.
     *
     * Mémoïsée parce que l'effet de téléportation en dépend : recréée à chaque
     * rendu, elle ferait rejouer cet effet en boucle tant qu'une cible est posée.
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
                    ? api.send('projects.update', { projectId: editing.id, project: draft })
                    : api.send('projects.add', { project: draft, securityTier })
            );
            // Invalider à la source de la mutation : la tuile d'accueil lit
            // `projects.count`, la liste lit `projects.list`.
            invalidate('projects.list', 'projects.count');
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
                    ? api.send('projects.archive', { projectId: summary.project.id })
                    : api.send('projects.restore', { projectId: summary.project.id })
            );
            invalidate('projects.list', 'projects.count');
        } catch (e) {
            setError(humanizeError(e, archived ? 'L’archivage a échoué.' : 'La restauration a échoué.'));
        }
    };

    /**
     * Archive depuis « Modifier le projet ».
     *
     * Si le projet archivé était ouvert, on referme sa vue : il vient de quitter
     * le portefeuille, l'y laisser affiché montrerait un écran qui ne correspond
     * plus à rien.
     */
    const archiveFromDialog = async (project: Project) => {
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(() => api.send('projects.archive', { projectId: project.id }));
            invalidate('projects.list', 'projects.count');
            setDialogOpen(false);
            if (opened?.id === project.id) {
                setOpened(null);
                setSelectedId(null);
            }
        } catch (e) {
            setDialogError(humanizeError(e, 'L’archivage a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Où une téléportation veut nous emmener.
     *
     * Deux usages, un seul mécanisme : rejoindre quelqu'un qui regarde un projet
     * (présence), et le « ouvrir le projet » de la feature Git, qui pose le même
     * chemin `view:projects l1:<id>`.
     *
     * La cible est rendue **tant qu'elle n'est pas atteinte** (voir
     * `useLiveSegment`) : si le portefeuille n'a pas fini de charger, l'effet la
     * retrouvera au rendu suivant, sans rien avoir à acquitter.
     */
    useEffect(() => {
        if (!liveTarget) return;
        if (liveTarget.value === null) {
            // « Ce niveau doit être refermé » — on remonte au portefeuille.
            setOpened(null);
            setSelectedId(null);
            return;
        }
        const id = Number(liveTarget.value.replace(/^project:/, ''));
        if (!Number.isFinite(id) || id === selectedId) return;
        const summary = summaries?.find((s) => s.project.id === id);
        // Pas encore chargé : la cible reste posée, on la retrouvera au rendu
        // suivant — c'est tout l'intérêt de ne rien avoir à acquitter.
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
     * On regarde autre chose que le portefeuille vivant — « mes tâches » ou les
     * archives. Ces écrans se ferment par un retour en tête de page et n'ont pas
     * d'actions à droite : un seul drapeau les décrit tous les deux.
     */
    const sideView = showMine || showArchived;

    /**
     * Ranger n'a de sens que sur le portefeuille vivant : les archives se lisent
     * dans l'ordre où l'on y a rangé les projets (`archived_at DESC`), un ordre
     * manuel n'y survivrait pas à la restauration, qui les renvoie en fin de
     * liste.
     */
    const canReorder = canWrite && !sideView;

    // La grille compte plusieurs colonnes : le geste vise les gouttières
    // verticales, et non les interstices horizontaux des listes en colonne.
    //
    // Les projets projetés en sont exclus de bout en bout : ni comme source
    // (pas de poignée), ni dans l'ordre envoyé (le serveur refuse un ordre qui
    // les inclut), ni parmi les rangées visées (leur carte ne porte pas
    // `data-project-card`). Rangés en queue, ils n'occupent aucun des
    // interstices qu'un dépôt peut viser.
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: summaries?.flatMap((s) => (s.foreign ? [] : [s.project.id])) ?? [],
        rowSelector: '[data-project-card]',
        layout: 'grid',
        onReorder: (ids) => reorder(ids as number[]),
        onDragStateChange
    });

    // La session livre l'utilisateur avant qu'une feature ne se monte : le
    // `null` est un cas du type, pas un état de l'écran. Rien à rendre sans lui,
    // le fil de discussion a besoin de savoir qui écrit.
    if (me === null) return null;

    // Vue détail : le portefeuille cède la place, mais reste monté derrière —
    // le retour est alors instantané et sans re-sollicitation.
    if (opened) {
        return (
            <>
                <ProjectDetail
                    project={opened}
                    members={members}
                    meUserId={me.id}
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
                    allowGuarded={allowGuarded}
                    busy={busy}
                    error={dialogError}
                    onClose={() => setDialogOpen(false)}
                    onSubmit={(result) => void submit(result)}
                    onArchive={canWrite && editing ? () => void archiveFromDialog(editing) : undefined}
                />
            </>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                {/* « Mes tâches » et les archives sont des écrans à part
                    entière, pas des filtres : on en sort par le même retour en
                    tête de page que la vue détail, et non par la bascule qui y
                    a mené. */}
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

                {/* Rien à droite sur ces écrans-là : deux sorties concurrentes
                    pour un même écran ne feraient qu'embrouiller. */}
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

                        {canWrite && (
                            <Button icon='add' onClick={openCreate}>
                                Nouveau projet
                            </Button>
                        )}
                    </div>
                )}
            </header>

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
                        : `Aucun projet pour l’instant.${canWrite ? ' Créez-en un pour commencer à suivre son avancement.' : ''}`}
                </p>
            )}

            {!showMine && summaries && summaries.length > 0 && (
                <ul ref={drag.listRef} className={styles.grid}>
                    {summaries.map((summary) => (
                        <ProjectCard
                            key={summary.project.id}
                            summary={summary}
                            canWrite={canWrite}
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
                    {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un
                        `<li>` est un enfant valide. Sorti du flux par
                        `position: absolute`, il n'occupe aucune cellule. */}
                    <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
                </ul>
            )}

            <ProjectDialog
                open={dialogOpen}
                project={editing}
                allowGuarded={allowGuarded}
                busy={busy}
                error={dialogError}
                onClose={() => setDialogOpen(false)}
                onSubmit={(result) => void submit(result)}
                onArchive={canWrite && editing ? () => void archiveFromDialog(editing) : undefined}
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
    /** Cette carte est celle qu'on déplace : elle s'estompe sur place. */
    dragging: boolean;
    onOpen: () => void;
    onArchive: () => void;
    /** Absent = pas de poignée : ranger est une écriture, et non dans les archives. */
    onDragPointerDown?: (e: ReactPointerEvent) => void;
}

/**
 * Une ligne du portefeuille.
 *
 * Une ligne pleine largeur et non une carte de grille : ce qui distingue deux
 * projets tient dans un titre et quelques chiffres, et une grille de cartes
 * imposait une hauteur minimale commune (168 px) que la plupart ne remplissaient
 * pas. En ligne, l'avancement peut de surcroît occuper toute la place restante
 * plutôt qu'un filet de 300 px.
 */
function ProjectCard({
    summary,
    canWrite,
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
        // `data-project-card` désigne une rangée que le glisser-classer peut
        // viser : un projet projeté n'en est pas une (voir `useDragReorder`).
        <li
            className={`${styles.card} ${dragging ? styles.cardDragging : ''}`}
            data-project-card={foreign ? undefined : ''}
            {...outline}
        >
            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne peut donc pas remonter jusqu'à « ouvrir le
                projet », même sans le neutraliser. */}
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

            {/* `div role="button"` et non `<button>` : la carte contient un
                titre, un paragraphe et une liste d'étiquettes, c'est-à-dire du
                contenu de flux — interdit dans un bouton, dont le modèle de
                contenu est phrasé. Les navigateurs rendaient alors la carte
                mal dimensionnée et l'interaction devenait erratique. Même
                motif que la carte du kanban, qui fonctionne. */}
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
                {/* La vignette, en tête de carte : c'est elle qu'on reconnaît
                    avant d'avoir lu le titre, une fois qu'on en a plusieurs.
                    Masquée sur un projet verrouillé, comme le titre — une image
                    identifie autant qu'un nom. */}
                <span className={styles.cardIcon} aria-hidden='true'>
                    {!masked && project.icon ? (
                        <img src={project.icon} alt='' />
                    ) : (
                        <span className='icon icon-projects' />
                    )}
                </span>

                <div className={styles.cardIdent}>
                    <div className={styles.cardTitleRow}>
                        {/* Le statut ouvre la ligne : c'est la première chose
                            qu'on cherche en balayant la liste, elle doit se lire
                            sans avoir à traverser le titre. */}
                        <span className={styles.status} data-status={project.status}>
                            {STATUS_LABELS[project.status]}
                        </span>
                        {project.securityTier === 'guarded' && (
                            <span className={styles.lock} title='Projet confidentiel'>
                                <span className='icon icon-lock' />
                            </span>
                        )}
                        {/* Projeté depuis un autre espace : il se lit et se
                            travaille comme les autres, mais ne se classe pas
                            d'ici et ses liaisons se règlent là-bas. Sans cette
                            pastille, rien ne distinguerait une ligne locale
                            d'une fenêtre sur l'espace voisin. Même pastille
                            que les notes, les boîtes mail et les uptimes. */}
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

                {/* Sous l'identité, et non à côté : en ligne, tout le milieu
                    de la carte restait vide et l'avancement se retrouvait à
                    l'autre bout de l'écran, loin du titre qu'il décrit. En
                    grille, la barre reprend toute la largeur de la carte, donc
                    la même sur toutes — deux avancements se comparent encore
                    d'un coup d'œil, ce qui est tout ce qu'on lui demande. */}
                <div className={styles.cardProgress}>
                    {/* Tout ce qui se lit en mots passe **au-dessus** de la
                        barre, le décompte des tâches calé à droite contre son
                        extrémité : la carte se termine alors sur la barre au
                        lieu d'une ligne de texte, et l'avancement se compare
                        sans qu'un bloc s'intercale entre deux cartes. */}
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
                    {/* Badge visible uniquement s'il y a réellement du non-lu. */}
                    {unread > 0 && <span className={styles.unread}>{unread}</span>}

                    {/* Symbole, pas bouton : il dit que toute la ligne est
                        cliquable. « Archiver » a quitté cette place pour
                        « Modifier le projet » — c'est un geste rare, il n'a pas
                        à être le plus accessible de l'écran. */}
                    <span className={styles.openArrow} aria-hidden='true'>
                        <span className='icon icon-arrow' />
                    </span>
                </div>
            </div>

            {/* Dans les archives, en revanche, restaurer est le **seul** geste de
                l'écran : l'enfouir dans une popup ajouterait trois clics à
                l'unique action qu'on vient y faire. */}
            {canWrite && archived && (
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
