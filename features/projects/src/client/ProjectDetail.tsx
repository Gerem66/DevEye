import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    StatusBadge,
    useLiveOutlines,
    useLiveSegment,
    useResourceVersion,
    useStickyOffset,
    withSecrecy
} from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { api, moveRefusal, STATUS_LABELS } from './api';
import type {
    Project,
    ProjectCard,
    ProjectCardDep,
    ProjectCardDraft,
    ProjectColumn,
    ProjectMilestone,
    ProjectMilestoneDraft
} from '../contracts/domain';
import { Board } from './Board/Board';
import { CardDialog, type CardTab } from './Board/CardDialog';
import { ColumnDialog, type ColumnDialogResult } from './Board/ColumnDialog';
import { Timeline } from './Timeline/Timeline';
import { MilestoneDialog } from './Timeline/MilestoneDialog';
import { History } from './History/History';
import { ArchivedCardDialog } from './History/ArchivedCardDialog';
import { Git } from './Git/Git';
import { Databases } from './Database/Databases';
import { Audience } from './Audience/Audience';
import { Deploy } from './Deploy/Deploy';
import { Uptime } from './Uptime/Uptime';
import { Overview } from './Dashboard/Overview';
import { AddFeatureDialog } from './AddFeatureDialog';
import { ProjectTabs } from './ProjectTabs';
import { isProjectTabId, landingTab, type ProjectTabAddKey, type ProjectTabId } from './tabs';
import { useProjectTabs } from './useProjectTabs';
import { useProjectRights } from './rights';
import styles from './style.module.css';

interface ProjectDetailProps {
    project: Project;
    members: readonly MinimalUser[];
    /** L'appelant : sert au fil de discussion (frappe, mentions) et aux droits. */
    meUserId: number;
    onBack: () => void;
}

/**
 * Un projet ouvert : son en-tête, ses onglets, et le contenu de celui qu'on lit.
 * Possède les niveaux `l2` (l'onglet) et `l3` (la carte ouverte) de la présence ;
 * `l1` est au parent, et un niveau n'admet qu'un déclarant.
 */
export function ProjectDetail({ project, members, meUserId, onBack }: ProjectDetailProps) {
    const [tab, setTab] = useState<ProjectTabId>(landingTab(project));

    // Les droits se lisent sur CE projet : une surcharge posée sur lui seul
    // ouvre ou ferme des gestes que le portefeuille, qui ne connaît que le rôle,
    // ne saurait pas trancher.
    const rights = useProjectRights(project.id, meUserId);
    const { canWrite } = rights;

    const tabs = useProjectTabs(project, rights.canLinks);
    /** Le geste que le menu « + » a lancé, tant qu'il n'est pas clos. */
    const [adding, setAdding] = useState<ProjectTabAddKey | null>(null);

    // Un onglet peut porter son propre bandeau collant (Audience et sa barre de
    // période) : il se pose sous l'en-tête du projet, dont la hauteur varie avec
    // le titre et les retours à la ligne des onglets. D'où la mesure.
    const sticky = useStickyOffset<HTMLDivElement>();
    const [columns, setColumns] = useState<ProjectColumn[]>([]);
    const [cards, setCards] = useState<ProjectCard[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * L'échec d'un geste, à part de `error` : le geste raté re-sollicite le tableau,
     * et une relecture réussie efface `error`. Reste jusqu'à ce qu'on le ferme, ou
     * jusqu'au geste suivant.
     */
    const [actionError, setActionError] = useState<string | null>(null);

    const [cardDialog, setCardDialog] = useState<{
        card: ProjectCard | null;
        columnId: number | null;
        /** L'onglet demandé par le geste d'ouverture. */
        focus?: CardTab;
    } | null>(null);
    const [columnDialog, setColumnDialog] = useState<{ column: ProjectColumn | null } | null>(null);
    const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
    const [deps, setDeps] = useState<ProjectCardDep[]>([]);
    const [milestoneDialog, setMilestoneDialog] = useState<{ milestone: ProjectMilestone | null } | null>(null);
    const [archivedCards, setArchivedCards] = useState<ProjectCard[]>([]);
    const [archivedView, setArchivedView] = useState<ProjectCard | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);

    const version = useResourceVersion('projects.board');
    const reloadRef = useRef<Promise<void> | null>(null);

    /*
     * Présence « qui regarde quoi, dans ce projet ». L'onglet est un niveau à part
     * entière : le chemin décide aussi à qui le serveur transmet les curseurs,
     * seuls les pairs exactement au même endroit se voient. La carte ouverte
     * descend donc en `l3`.
     */
    const tabTarget = useLiveSegment('l2', `tab:${tab}`);
    const cardTarget = useLiveSegment('l3', cardDialog?.card ? `card:${cardDialog.card.id}` : null);
    const outlineForTab = useLiveOutlines('l2');

    // Rejoindre quelqu'un, c'est aussi arriver sur son onglet.
    useEffect(() => {
        if (!tabTarget?.value) return;
        const wanted = tabTarget.value.replace(/^tab:/, '');
        // Contre la liste complète : celui qu'on rejoint est forcément sur un
        // onglet qui a du contenu, dont les compteurs peuvent n'être pas arrivés.
        if (isProjectTabId(wanted)) setTab(wanted);
    }, [tabTarget]);

    /*
     * Un onglet quitte la barre avec son dernier élément, et on ne peut pas rester
     * sur un onglet qui n'existe plus : repli sur l'onglet d'arrivée. Attendre `ready` est
     * ce qui rend l'ajout depuis le « + » possible, compteurs inconnus ne renvoie
     * personne nulle part.
     */
    useEffect(() => {
        if (!tabs.ready) return;
        if (!tabs.visible.some((t) => t.id === tab)) setTab(landingTab(project));
    }, [tabs.ready, tabs.visible, tab, project.showOverview]);

    /**
     * Déclarer le niveau ne suffit pas : il dit où on est, pas où l'on nous demande
     * d'aller. La cible reste posée tant qu'elle n'est pas atteinte, l'effet la
     * retrouvera quand `cards` changera.
     */
    useEffect(() => {
        if (!cardTarget) return;
        if (cardTarget.value === null) {
            setCardDialog(null);
            return;
        }
        const id = Number(cardTarget.value.replace(/^card:/, ''));
        if (!Number.isFinite(id) || cardDialog?.card?.id === id) return;
        const card = cards.find((c) => c.id === id);
        if (!card) return;
        setDialogError(null);
        setCardDialog({ card, columnId: card.columnId });
    }, [cardTarget, cards, cardDialog]);

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                // Un projet confidentiel exige une session déverrouillée : les
                // titres des cartes sont chiffrés au même étage que le projet.
                const [board, plan, archived] = await Promise.all([
                    withSecrecy(() => api.send('projects.board', { projectId: project.id })),
                    withSecrecy(() => api.send('projects.plan', { projectId: project.id })),
                    // Les cartes archivées d'avance : l'historique en ouvre une
                    // en lecture seule sans second aller-retour.
                    withSecrecy(() => api.send('projects.board', { projectId: project.id, archived: true }))
                ]);
                setColumns(board.columns);
                setCards(board.cards);
                setMilestones(plan.milestones);
                setDeps(plan.deps);
                setArchivedCards(archived.cards);
                // La popup détient sa propre copie de la carte : sans cette remise
                // à jour, une modification venue d'ailleurs n'atteindrait que le
                // tableau derrière.
                setCardDialog((prev) => {
                    if (!prev?.card) return prev;
                    const fresh = board.cards.find((c) => c.id === prev.card?.id);
                    // Absente = archivée entre-temps : on garde ce qu'on a
                    // plutôt que de vider la popup sous les yeux de son lecteur.
                    return fresh ? { ...prev, card: fresh } : prev;
                });
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger le tableau.'));
            } finally {
                setLoaded(true);
            }
        })();
        reloadRef.current = task;
        try {
            await task;
        } finally {
            reloadRef.current = null;
        }
    }, [project.id]);

    /** Un glissé du tableau est en cours : une relecture déferait son aperçu sous le pointeur. */
    const boardDragging = useRef(false);
    const reloadHeld = useRef(false);

    useEffect(() => {
        if (boardDragging.current) reloadHeld.current = true;
        else void reload();
    }, [reload, version]);

    const onBoardDrag = (dragging: boolean) => {
        boardDragging.current = dragging;
        if (dragging || !reloadHeld.current) return;
        reloadHeld.current = false;
        void reload();
    };

    /**
     * Déplacement optimiste : sans le nouvel ordre posé tout de suite, la carte
     * reviendrait en arrière le temps de l'aller-retour. Un échec re-sollicite.
     */
    const onCardsMoved = async (columnId: number, cardIds: number[], next: ProjectCard[]) => {
        const before = cards;
        setCards(next);
        setActionError(null);
        try {
            await api.send('projects.cardMove', { columnId, cardIds });
            invalidate('projects.list');
        } catch (e) {
            setActionError(moveRefusal(e, before) ?? humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    /**
     * Ni le jalon ni les dépendances ne tiennent dans le brouillon chiffré : ce
     * sont des commandes à part, qui exigent un identifiant de carte. La popup rend
     * l'état voulu, on le rapproche ici de l'état connu pour n'émettre que la
     * différence, et rien ne part avant « Enregistrer ».
     */
    const submitCard = async (draft: ProjectCardDraft, links: { milestoneId: number | null; blockedBy: number[] }) => {
        if (!cardDialog) return;
        setBusy(true);
        setDialogError(null);
        // Une modification porte sa carte, une création la colonne où elle naît.
        const target = cardDialog.card ?? cardDialog.columnId;
        if (target === null) return;
        try {
            await withSecrecy(async () => {
                const existing = cardDialog.card;
                const cardId =
                    typeof target === 'number'
                        ? (await api.send('projects.cardAdd', { projectId: project.id, columnId: target, card: draft }))
                              .card.id
                        : (await api.send('projects.cardUpdate', { cardId: target.id, card: draft })).card.id;

                if (links.milestoneId !== (existing?.milestoneId ?? null)) {
                    await api.send('projects.cardSetMilestone', { cardId, milestoneId: links.milestoneId });
                }

                const before = existing
                    ? deps.filter((d) => d.cardId === existing.id).map((d) => d.blockedByCardId)
                    : [];
                // En série et non en parallèle : le serveur refuse les cycles en
                // lisant le graphe, une rafale simultanée le ferait juger sur un
                // état incomplet.
                for (const id of links.blockedBy.filter((id) => !before.includes(id))) {
                    await api.send('projects.depAdd', { cardId, blockedByCardId: id });
                }
                for (const id of before.filter((id) => !links.blockedBy.includes(id))) {
                    await api.send('projects.depRemove', { cardId, blockedByCardId: id });
                }
            });
            invalidate('projects.board', 'projects.list');
            setCardDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * `cardUpdate` ne connaît pas la modification partielle : il prend un brouillon
     * complet et réécrit le corps chiffré. Une retouche ponctuelle repart donc de
     * la carte enregistrée, sans emporter une saisie en cours dans la popup.
     * Optimiste, comme le déplacement d'une carte.
     */
    const patchCard = async (card: ProjectCard, change: Partial<ProjectCard>, failure: string) => {
        setActionError(null);
        const next = { ...card, ...change };
        const draft: ProjectCardDraft = {
            title: next.title,
            description: next.description,
            checklist: next.checklist,
            priority: next.priority,
            assigneeUserId: next.assigneeUserId,
            startDate: next.startDate,
            dueDate: next.dueDate,
            estimateMinutes: next.estimateMinutes
        };
        setCards((prev) => prev.map((c) => (c.id === card.id ? next : c)));
        // La popup détient sa propre copie : sans ça, le prochain geste repartirait
        // de la version d'avant et déferait celui-ci.
        setCardDialog((prev) => (prev?.card?.id === card.id ? { ...prev, card: next } : prev));
        try {
            await withSecrecy(() => api.send('projects.cardUpdate', { cardId: card.id, card: draft }));
            invalidate('projects.board', 'projects.list');
        } catch (e) {
            setActionError(humanizeError(e, failure));
            void reload();
        }
    };

    const archiveCard = async () => {
        if (!cardDialog?.card) return;
        setBusy(true);
        try {
            await withSecrecy(() => api.send('projects.cardArchive', { cardId: cardDialog.card!.id }));
            invalidate('projects.board', 'projects.list');
            setCardDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’archivage a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const submitColumn = async (result: ColumnDialogResult) => {
        if (!columnDialog) return;
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(() =>
                columnDialog.column
                    ? api.send('projects.columnUpdate', {
                          columnId: columnDialog.column.id,
                          name: result.name,
                          countsAsDone: result.countsAsDone,
                          wipLimit: result.wipLimit
                      })
                    : api.send('projects.columnAdd', {
                          projectId: project.id,
                          name: result.name,
                          countsAsDone: result.countsAsDone,
                          wipLimit: result.wipLimit
                      })
            );
            invalidate('projects.board', 'projects.list');
            setColumnDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const removeColumn = async () => {
        if (!columnDialog?.column) return;
        setBusy(true);
        setDialogError(null);
        try {
            await api.send('projects.columnRemove', { columnId: columnDialog.column.id });
            invalidate('projects.board', 'projects.list');
            setColumnDialog(null);
        } catch (e) {
            // Le serveur refuse tant que la colonne porte des cartes : son
            // message dit exactement combien, on l'affiche tel quel.
            setDialogError(humanizeError(e, 'Le retrait a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const restoreArchivedCard = async () => {
        if (!archivedView) return;
        setBusy(true);
        try {
            await withSecrecy(() => api.send('projects.cardRestore', { cardId: archivedView.id }));
            invalidate('projects.board', 'projects.list');
            setArchivedView(null);
        } catch (e) {
            setActionError(humanizeError(e, 'La restauration a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const submitMilestone = async (draft: ProjectMilestoneDraft) => {
        if (!milestoneDialog) return;
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(() =>
                milestoneDialog.milestone
                    ? api.send('projects.milestoneUpdate', {
                          milestoneId: milestoneDialog.milestone.id,
                          milestone: draft
                      })
                    : api.send('projects.milestoneAdd', { projectId: project.id, milestone: draft })
            );
            invalidate('projects.board');
            setMilestoneDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const setMilestoneReached = async (reached: boolean) => {
        if (!milestoneDialog?.milestone) return;
        try {
            const res = await api.send('projects.milestoneSetReached', {
                milestoneId: milestoneDialog.milestone.id,
                reached
            });
            setMilestoneDialog({ milestone: res.milestone });
            invalidate('projects.board');
        } catch (e) {
            setDialogError(humanizeError(e, 'La mise à jour a échoué.'));
        }
    };

    const removeMilestone = async () => {
        if (!milestoneDialog?.milestone) return;
        setBusy(true);
        try {
            const id = milestoneDialog.milestone.id;
            await withSecrecy(() => api.send('projects.milestoneRemove', { milestoneId: id }));
            invalidate('projects.board');
            setMilestoneDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'Le retrait a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const moveColumn = async (columnId: number, direction: -1 | 1) => {
        const ids = columns.map((c) => c.id);
        const from = ids.indexOf(columnId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        setColumns(ids.map((id) => columns.find((c) => c.id === id) as ProjectColumn));
        try {
            await api.send('projects.columnReorder', { projectId: project.id, columnIds: ids });
        } catch (e) {
            setActionError(humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    return (
        <div className={tab === 'board' ? `${styles.root} ${styles.rootFit}` : styles.root} style={sticky.style}>
            {/* En-tête et onglets dans un seul bloc collant : deux blocs
                superposés glisseraient l'un sous l'autre au défilement. */}
            <div ref={sticky.ref} className={styles.detailSticky}>
                <header className={styles.header}>
                    <div className={styles.detailHead}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Projets
                        </Button>
                        <div className={styles.detailTitle}>
                            <h2 className={styles.heading}>{project.title || 'Sans titre'}</h2>
                            <span className={styles.status} data-status={project.status}>
                                {STATUS_LABELS[project.status]}
                            </span>
                            {project.version && <span className={styles.version}>v{project.version}</span>}
                            {project.securityTier === 'guarded' && (
                                <span className={styles.lock} title='Projet confidentiel'>
                                    <span className='icon icon-lock' />
                                </span>
                            )}
                            {/* Tout l'arbre se travaille d'ici ; les gestes du
                                domicile (palier, liaisons, classement) restent
                                là-bas. */}
                            {project.foreign && (
                                <span
                                    className={styles.shared}
                                    title='Ce projet appartient à un autre espace qui le partage ici'
                                >
                                    <StatusBadge tone='accent'>partagé</StatusBadge>
                                </span>
                            )}
                        </div>
                    </div>
                    <div className={styles.actions}>
                        {/* Les réglages de ce projet, son profil et son archivage
                            compris (onglet Général). Partage n'est pas proposé
                            pour un projet confidentiel, que le serveur refuserait
                            de projeter. Archivé ou déplacé depuis la coquille, le
                            projet n'est plus ici : la fiche revient au
                            portefeuille. */}
                        <FeatureSettingsButton
                            scope={{
                                kind: 'item',
                                feature: 'projects',
                                itemId: String(project.id),
                                itemLabel: project.title || 'Sans titre',
                                shareable: project.securityTier === 'open'
                            }}
                            onGone={onBack}
                        />
                    </div>
                </header>

                <ProjectTabs
                    tabs={tabs.visible}
                    active={tab}
                    onSelect={setTab}
                    addable={tabs.addable}
                    onAdd={(_tab, action) => setAdding(action.key)}
                    outline={outlineForTab}
                />
            </div>

            {error && <p className={styles.error}>{error}</p>}
            {actionError && (
                <p className={styles.errorDismissible} role='alert'>
                    <span>{actionError}</span>
                    <button
                        type='button'
                        className={styles.errorClose}
                        aria-label='Fermer ce message'
                        onClick={() => setActionError(null)}
                    >
                        <span className='icon icon-x' />
                    </button>
                </p>
            )}
            {!loaded && <p className={styles.empty}>Chargement…</p>}

            {loaded && tab === 'overview' && (
                <Overview
                    project={project}
                    columns={columns}
                    cards={cards}
                    milestones={milestones}
                    deps={deps}
                    meUserId={meUserId}
                    canWrite={rights.canLinks}
                    onOpenCard={(card) => {
                        setDialogError(null);
                        setCardDialog({ card, columnId: card.columnId });
                    }}
                    onOpenTab={setTab}
                />
            )}

            {loaded && tab === 'board' && (
                <Board
                    columns={columns}
                    cards={cards}
                    canWrite={canWrite}
                    canTasks={rights.canTasks}
                    canManage={rights.canManage}
                    onCardsPreview={setCards}
                    onDragStateChange={onBoardDrag}
                    onCardsMoved={(columnId, cardIds, next) => void onCardsMoved(columnId, cardIds, next)}
                    onCardOpen={(card, focus) => {
                        setDialogError(null);
                        setCardDialog({ card, columnId: card.columnId, focus });
                    }}
                    onCardCreate={(columnId) => {
                        setDialogError(null);
                        setCardDialog({ card: null, columnId });
                    }}
                    onColumnEdit={(column) => {
                        setDialogError(null);
                        setColumnDialog({ column });
                    }}
                    onColumnMove={(columnId, direction) => void moveColumn(columnId, direction)}
                    onColumnCreate={() => {
                        setDialogError(null);
                        setColumnDialog({ column: null });
                    }}
                />
            )}

            {loaded && tab === 'timeline' && (
                <Timeline
                    cards={cards}
                    milestones={milestones}
                    deps={deps}
                    canPlan={rights.canPlan}
                    canDate={rights.canDate}
                    onCardOpen={(card) => {
                        setDialogError(null);
                        setCardDialog({ card, columnId: card.columnId });
                    }}
                    onCardDates={(card, startDate, dueDate) =>
                        void patchCard(card, { startDate, dueDate }, 'Le déplacement a échoué.')
                    }
                    onMilestoneCreate={() => {
                        setDialogError(null);
                        setMilestoneDialog({ milestone: null });
                    }}
                    onMilestoneOpen={(milestone) => {
                        setDialogError(null);
                        setMilestoneDialog({ milestone });
                    }}
                />
            )}

            {loaded && tab === 'git' && <Git project={project} canWrite={rights.canLinks} />}
            {loaded && tab === 'database' && <Databases project={project} canWrite={rights.canLinks} />}
            {loaded && tab === 'audience' && <Audience project={project} canWrite={rights.canLinks} />}

            {loaded && tab === 'deploy' && <Deploy project={project} canWrite={rights.canLinks} />}
            {loaded && tab === 'uptime' && <Uptime project={project} canWrite={rights.canLinks} />}

            {loaded && tab === 'history' && (
                <History
                    projectId={project.id}
                    archivedCards={archivedCards}
                    onOpenArchived={(card) => setArchivedView(card)}
                />
            )}

            {/* Le geste d'ajout lancé depuis le « + » : dès qu'il aboutit,
                l'onglet existe et s'ouvre dans la foulée. */}
            <AddFeatureDialog
                projectId={project.id}
                pending={adding}
                onClose={() => setAdding(null)}
                onAdded={(id) => {
                    setAdding(null);
                    tabs.reveal(id);
                    setTab(id);
                }}
            />

            <ArchivedCardDialog
                open={archivedView !== null}
                card={archivedView}
                canWrite={rights.canTasks}
                busy={busy}
                onClose={() => setArchivedView(null)}
                onRestore={() => void restoreArchivedCard()}
            />

            <MilestoneDialog
                open={milestoneDialog !== null}
                milestone={milestoneDialog?.milestone ?? null}
                canPlan={rights.canPlan}
                busy={busy}
                error={dialogError}
                onClose={() => setMilestoneDialog(null)}
                onSubmit={(draft) => void submitMilestone(draft)}
                onSetReached={
                    milestoneDialog?.milestone && rights.canPlan ? (r) => void setMilestoneReached(r) : undefined
                }
                onRemove={milestoneDialog?.milestone && rights.canPlan ? () => void removeMilestone() : undefined}
            />

            <CardDialog
                open={cardDialog !== null}
                card={cardDialog?.card ?? null}
                focus={cardDialog?.focus}
                members={members}
                meUserId={meUserId}
                canWrite={canWrite}
                canDate={cardDialog?.card ? rights.canDate(cardDialog.card) : rights.canWrite}
                canPlan={rights.canPlan}
                canChat={rights.canChat}
                siblings={cards}
                milestones={milestones}
                deps={deps}
                busy={busy}
                error={dialogError}
                onClose={() => setCardDialog(null)}
                onSubmit={(draft, links) => void submitCard(draft, links)}
                onChecklistChange={(checklist) => {
                    if (cardDialog?.card) void patchCard(cardDialog.card, { checklist }, 'L’enregistrement a échoué.');
                }}
                onRead={() => {
                    const id = cardDialog?.card?.id;
                    if (id === undefined) return;
                    setCards((prev) => prev.map((c) => (c.id === id && c.unread > 0 ? { ...c, unread: 0 } : c)));
                    setCardDialog((prev) =>
                        prev?.card?.id === id && prev.card.unread > 0
                            ? { ...prev, card: { ...prev.card, unread: 0 } }
                            : prev
                    );
                }}
                onArchive={cardDialog?.card && rights.canTasks ? () => void archiveCard() : undefined}
            />

            <ColumnDialog
                open={columnDialog !== null}
                column={columnDialog?.column ?? null}
                busy={busy}
                error={dialogError}
                onClose={() => setColumnDialog(null)}
                onSubmit={(result) => void submitColumn(result)}
                onRemove={columnDialog?.column ? () => void removeColumn() : undefined}
            />
        </div>
    );
}

export default ProjectDetail;
