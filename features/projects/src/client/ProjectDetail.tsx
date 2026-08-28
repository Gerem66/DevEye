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
import { api, STATUS_LABELS } from './api';
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
import { CardDialog } from './Board/CardDialog';
import { ColumnDialog, type ColumnDialogResult } from './Board/ColumnDialog';
import { Timeline } from './Timeline/Timeline';
import { MilestoneDialog } from './Timeline/MilestoneDialog';
import { History } from './History/History';
import { ArchivedCardDialog } from './History/ArchivedCardDialog';
import { Git } from './Git/Git';
import { Databases } from './Database/Databases';
import { Audience } from './Audience/Audience';
import { Deploy } from './Deploy/Deploy';
import { AddFeatureDialog } from './AddFeatureDialog';
import { ProjectTabs } from './ProjectTabs';
import { isProjectTabId, type ProjectTabAddKey, type ProjectTabId } from './tabs';
import { useProjectTabs } from './useProjectTabs';
import styles from './style.module.css';

interface ProjectDetailProps {
    project: Project;
    members: readonly MinimalUser[];
    /** L'appelant : sert au fil de discussion (frappe, mentions). */
    meUserId: number;
    canWrite: boolean;
    onBack: () => void;
    onEditProfile: () => void;
}

/**
 * Un projet ouvert : son en-tête, ses onglets, et le contenu de celui qu'on lit.
 *
 * **La barre d'onglets suit le contenu du projet.** Un projet neuf n'ouvre que
 * le tableau, la frise et l'historique ; les quatre onglets d'intégration
 * paraissent avec leur premier élément et se replient dans le menu « + » quand
 * le dernier s'en va (la règle vit dans `tabs.ts`, les compteurs dans
 * `useProjectTabs`). C'est aussi ce qui rend le geste d'ajout accessible sans
 * onglet : le menu ouvre le formulaire de la feature, et l'onglet naît de ce
 * qu'on y met.
 *
 * Ce composant possède le niveau `l2` de la présence (la carte ouverte) ; le
 * niveau `l1` (le projet) est déclaré par le composant parent. La règle « un
 * seul déclarant par niveau » (voir LIVE.md) interdit d'en poser un second.
 */
export function ProjectDetail({ project, members, meUserId, canWrite, onBack, onEditProfile }: ProjectDetailProps) {
    const [tab, setTab] = useState<ProjectTabId>('board');

    const tabs = useProjectTabs(project, canWrite);
    /** Le geste que le menu « + » a lancé, tant qu'il n'est pas clos. */
    const [adding, setAdding] = useState<ProjectTabAddKey | null>(null);

    // Ce que les onglets rendent peut porter son propre bandeau collant : c'est
    // le cas de l'onglet Audience et de sa barre de période. Elle doit se poser
    // **sous** l'en-tête du projet, dont la hauteur varie avec le titre et les
    // retours à la ligne de la barre d'onglets. On la mesure donc.
    const sticky = useStickyOffset<HTMLDivElement>();
    const [columns, setColumns] = useState<ProjectColumn[]>([]);
    const [cards, setCards] = useState<ProjectCard[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [cardDialog, setCardDialog] = useState<{ card: ProjectCard | null; columnId: number } | null>(null);
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
     * Présence : « qui regarde quoi, dans ce projet ».
     *
     * L'onglet est un niveau à part entière, entre le projet et la carte. Ce
     * n'est pas un raffinement d'affichage : un chemin détermine aussi à qui le
     * serveur transmet les curseurs — seuls les pairs situés *exactement* au même
     * endroit se voient. Sans ce niveau, quelqu'un resté sur la frise promenait
     * son curseur en travers du tableau de son voisin.
     *
     * La carte ouverte descend donc en `l3`, et les contours qui la désignaient
     * suivent (voir `Board` et `Timeline`).
     */
    const tabTarget = useLiveSegment('l2', `tab:${tab}`);
    const cardTarget = useLiveSegment('l3', cardDialog?.card ? `card:${cardDialog.card.id}` : null);
    const outlineForTab = useLiveOutlines('l2');

    // Rejoindre quelqu'un, c'est aussi arriver sur son onglet.
    useEffect(() => {
        if (!tabTarget?.value) return;
        const wanted = tabTarget.value.replace(/^tab:/, '');
        // Contre la liste **complète** : celui qu'on rejoint est forcément sur un
        // onglet qui a du contenu, et les compteurs qui le confirmeront peuvent
        // n'être pas encore arrivés.
        if (isProjectTabId(wanted)) setTab(wanted);
    }, [tabTarget]);

    /*
     * Le dernier élément d'une feature vient d'être retiré : son onglet quitte la
     * barre, et on ne peut pas rester sur un onglet qui n'existe plus. Le tableau
     * est le repli naturel — c'est là qu'on entre dans un projet.
     *
     * Attendre `ready` est ce qui rend l'ajout depuis le « + » possible : tant
     * que les compteurs sont inconnus, on ne renvoie personne nulle part.
     */
    useEffect(() => {
        if (!tabs.ready) return;
        if (!tabs.visible.some((t) => t.id === tab)) setTab('board');
    }, [tabs.ready, tabs.visible, tab]);

    /**
     * … et jusque dans la tâche qu'il a ouverte.
     *
     * Le dernier maillon de la chaîne — accueil → projet → onglet → carte.
     * Déclarer le niveau ne suffit pas : il dit où **on** est, pas où l'on nous
     * demande d'aller. Sans ce répondant, une téléportation s'arrêtait sur le bon
     * onglet et laissait la carte fermée.
     *
     * La cible reste posée tant qu'elle n'est pas atteinte : si le tableau n'a
     * pas fini de charger, l'effet la retrouvera au rendu suivant, quand `cards`
     * changera — rien à acquitter.
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

    // La largeur de la popup n'est plus décidée ici : `Board` et `Timeline`
    // déclarent chacun celle que **leur contenu** réclame (voir
    // `stores/popupWidth`). Un seul onglet est monté à la fois, donc il n'y a
    // jamais qu'un demandeur — et cet écran n'a pas à connaître la géométrie
    // interne de ses onglets.

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                // Un projet confidentiel exige une session déverrouillée : les
                // titres des cartes sont chiffrés au même étage que le projet.
                // Le tableau et la planification en parallèle : la frise a
                // besoin des deux, et un seul aller-retour de plus ne coûte rien.
                const [board, plan, archived] = await Promise.all([
                    withSecrecy(() => api.send('projects.board', { projectId: project.id })),
                    withSecrecy(() => api.send('projects.plan', { projectId: project.id })),
                    // Les cartes archivées : c'est ce qui permet à l'historique
                    // d'ouvrir un bloc en lecture seule sans second aller-retour.
                    withSecrecy(() => api.send('projects.board', { projectId: project.id, archived: true }))
                ]);
                setColumns(board.columns);
                setCards(board.cards);
                setMilestones(plan.milestones);
                setDeps(plan.deps);
                setArchivedCards(archived.cards);
                // La popup détient sa propre copie de la carte, et c'est elle
                // qu'elle affiche : sans cette remise à jour, une sous-tâche
                // cochée par quelqu'un d'autre arrivait bien dans le tableau
                // derrière, mais jamais dans la carte ouverte devant.
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

    useEffect(() => {
        void reload();
    }, [reload, version]);

    /**
     * Déplacement optimiste : l'état local prend le nouvel ordre tout de suite
     * (sinon la carte reviendrait en arrière le temps de l'aller-retour), puis
     * on persiste. Un échec re-sollicite, ce qui remet la vérité du serveur.
     */
    const onCardsMoved = async (columnId: number, cardIds: number[], next: ProjectCard[]) => {
        setCards(next);
        try {
            await api.send('projects.cardMove', { columnId, cardIds });
            invalidate('projects.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    /**
     * Enregistre la tâche : son corps, puis ses rattachements.
     *
     * Ni le jalon ni les dépendances ne tiennent dans le brouillon chiffré — ce
     * sont des commandes à part, qui exigent un identifiant de carte. La popup
     * ne les a donc pas envoyés de son côté ; elle rend l'état voulu, et c'est
     * ici qu'on le rapproche de l'état connu pour n'émettre que la différence.
     * Rien ne part tant qu'on n'a pas cliqué « Enregistrer ».
     */
    const submitCard = async (draft: ProjectCardDraft, links: { milestoneId: number | null; blockedBy: number[] }) => {
        if (!cardDialog) return;
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(async () => {
                const existing = cardDialog.card;
                const cardId = existing
                    ? (await api.send('projects.cardUpdate', { cardId: existing.id, card: draft })).card.id
                    : (
                          await api.send('projects.cardAdd', {
                              projectId: project.id,
                              columnId: cardDialog.columnId,
                              card: draft
                          })
                      ).card.id;

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
     * Écrit une carte sur place, à partir de ce qu'elle est déjà.
     *
     * `cardUpdate` ne connaît pas la modification partielle : il prend un
     * brouillon complet et réécrit le corps chiffré. Les retouches ponctuelles —
     * un glissé sur la frise, une case cochée — repartent donc de la carte
     * enregistrée, à laquelle elles ne changent que leur champ. C'est ce qui
     * garantit qu'elles n'emportent pas au passage une saisie en cours dans la
     * popup, restée volontairement en attente d'« Enregistrer ».
     *
     * Optimiste, comme le déplacement d'une carte du kanban : l'état local prend
     * la valeur tout de suite, sinon elle reviendrait en arrière le temps d'un
     * battement.
     */
    const patchCard = async (card: ProjectCard, change: Partial<ProjectCard>, failure: string) => {
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
        // de la version d'avant et défferait celui-ci.
        setCardDialog((prev) => (prev?.card?.id === card.id ? { ...prev, card: next } : prev));
        try {
            await withSecrecy(() => api.send('projects.cardUpdate', { cardId: card.id, card: draft }));
            invalidate('projects.board', 'projects.list');
        } catch (e) {
            setError(humanizeError(e, failure));
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
                    : api.send('projects.columnAdd', { projectId: project.id, name: result.name })
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
            setError(humanizeError(e, 'La restauration a échoué.'));
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
            setError(humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    return (
        <div className={styles.root} style={sticky.style}>
            {/* En-tête et onglets dans **un seul** bloc collant, et non deux
                superposés : l'un glisserait sous l'autre au défilement, ou
                obligerait à connaître la hauteur du premier pour caler le
                second. Un conteneur unique n'a pas ce problème. */}
            <div ref={sticky.ref} className={styles.detailSticky}>
                <header className={styles.header}>
                    <div className={styles.detailHead}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Projets
                        </Button>
                        {/* Titre et qualificatifs sur une seule ligne : le statut est
                        une propriété du titre, pas une légende sous celui-ci. */}
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
                            {/* Projeté depuis un autre espace : même pastille
                                que sur la carte du portefeuille. Tout l'arbre
                                se travaille d'ici ; les gestes du domicile
                                (palier, liaisons, classement) restent là-bas. */}
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
                        {/* Le bouton commun, comme partout : ses onglets sont
                            ceux que la coquille ajoute d'elle-même, Partage et
                            Permissions. L'onglet Partage n'est pas proposé pour
                            un projet confidentiel, que le serveur refuserait de
                            projeter (chiffré par le mot de passe). */}
                        <FeatureSettingsButton
                            scope={{
                                kind: 'item',
                                feature: 'projects',
                                itemId: project.id,
                                itemLabel: project.title || 'Sans titre',
                                shareable: project.securityTier === 'open'
                            }}
                        />
                        {canWrite && (
                            <Button variant='secondary' icon='edit' onClick={onEditProfile}>
                                Modifier le projet
                            </Button>
                        )}
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

            {/* Métadonnée de projet, donc hors des onglets : elle vaut quel que
                soit ce qu'on regarde. En repli, car c'est du contexte. */}

            {error && <p className={styles.error}>{error}</p>}
            {!loaded && <p className={styles.empty}>Chargement…</p>}

            {loaded && tab === 'board' && (
                <Board
                    columns={columns}
                    cards={cards}
                    canWrite={canWrite}
                    onCardsMoved={(columnId, cardIds, next) => void onCardsMoved(columnId, cardIds, next)}
                    onCardOpen={(card) => {
                        setDialogError(null);
                        setCardDialog({ card, columnId: card.columnId });
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
                    canWrite={canWrite}
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

            {loaded && tab === 'git' && <Git project={project} canWrite={canWrite} />}
            {loaded && tab === 'database' && <Databases project={project} canWrite={canWrite} />}
            {loaded && tab === 'audience' && <Audience project={project} canWrite={canWrite} />}

            {loaded && tab === 'deploy' && <Deploy project={project} canWrite={canWrite} />}

            {loaded && tab === 'history' && (
                <History
                    projectId={project.id}
                    archivedCards={archivedCards}
                    onOpenArchived={(card) => setArchivedView(card)}
                />
            )}

            {/* Le geste d'ajout lancé depuis le « + ». Il aboutit, l'onglet
                existe : on l'ouvre dans la foulée — c'est ce qu'on venait
                chercher, et personne n'a envie de le rouvrir à la main. */}
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
                canWrite={canWrite}
                busy={busy}
                onClose={() => setArchivedView(null)}
                onRestore={() => void restoreArchivedCard()}
            />

            <MilestoneDialog
                open={milestoneDialog !== null}
                milestone={milestoneDialog?.milestone ?? null}
                busy={busy}
                error={dialogError}
                onClose={() => setMilestoneDialog(null)}
                onSubmit={(draft) => void submitMilestone(draft)}
                onSetReached={milestoneDialog?.milestone && canWrite ? (r) => void setMilestoneReached(r) : undefined}
                onRemove={milestoneDialog?.milestone && canWrite ? () => void removeMilestone() : undefined}
            />

            <CardDialog
                open={cardDialog !== null}
                card={cardDialog?.card ?? null}
                members={members}
                meUserId={meUserId}
                canWrite={canWrite}
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
                onArchive={cardDialog?.card ? () => void archiveCard() : undefined}
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
