import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    MinimalUser,
    Project,
    ProjectCard,
    ProjectCardDep,
    ProjectCardDraft,
    ProjectColumn,
    ProjectMilestone,
    ProjectMilestoneDraft
} from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useRequestPopupWide } from '@/stores/popupWidth';
import { useLiveSegment } from '@/live/useLiveSegment';
import { humanizeError, STATUS_LABELS, withSecrecy } from './api';
import { Board } from './Board/Board';
import { CardDialog } from './Board/CardDialog';
import { ColumnDialog, type ColumnDialogResult } from './Board/ColumnDialog';
import { Timeline } from './Timeline/Timeline';
import { MilestoneDialog } from './Timeline/MilestoneDialog';
import { History } from './History/History';
import { ArchivedCardDialog } from './History/ArchivedCardDialog';
import { Git } from './Git/Git';
import { Deploy } from './Deploy/Deploy';
import { Links } from './Links/Links';
import styles from './style.module.css';

/** Les onglets du projet. Les suivants arrivent avec leurs phases. */
type TabId = 'board' | 'timeline' | 'git' | 'deploy' | 'history';

const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: 'board', label: 'Tableau', icon: 'projects' },
    { id: 'timeline', label: 'Frise', icon: 'clock' },
    { id: 'git', label: 'Git', icon: 'branch' },
    { id: 'deploy', label: 'Déploiement', icon: 'rocket' },
    // Dernier et discret : on l'ouvre rarement, pour une question précise.
    { id: 'history', label: 'Historique', icon: 'archive' }
];

interface ProjectDetailProps {
    project: Project;
    members: MinimalUser[];
    /** L'appelant : sert au fil de discussion (frappe, mentions). */
    meUserId: number;
    canWrite: boolean;
    onBack: () => void;
    onEditProfile: () => void;
}

/**
 * Un projet ouvert : son en-tête, ses onglets, et pour l'instant son tableau.
 *
 * Ce composant possède le niveau `l2` de la présence (la carte ouverte) ; le
 * niveau `l1` (le projet) est déclaré par le composant parent. La règle « un
 * seul déclarant par niveau » (voir LIVE.md) interdit d'en poser un second.
 */
export function ProjectDetail({ project, members, meUserId, canWrite, onBack, onEditProfile }: ProjectDetailProps) {
    const [tab, setTab] = useState<TabId>('board');
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

    const version = useResourceVersion('project.board');
    const reloadRef = useRef<Promise<void> | null>(null);

    // Présence : « qui regarde quelle carte ».
    useLiveSegment('l2', cardDialog?.card ? `card:${cardDialog.card.id}` : null);

    // Le tableau et la frise s'étalent horizontalement : sur un écran large, la
    // largeur de confort de lecture leur coûte des colonnes entières. Les autres
    // onglets sont du texte, et la gardent.
    useRequestPopupWide(tab === 'board' || tab === 'timeline');

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                // Un projet confidentiel exige une session déverrouillée : les
                // titres des cartes sont chiffrés au même étage que le projet.
                // Le tableau et la planification en parallèle : la frise a
                // besoin des deux, et un seul aller-retour de plus ne coûte rien.
                const [board, plan, archived] = await Promise.all([
                    withSecrecy(() => ws.send('project.board', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.plan', { projectId: project.id })),
                    // Les cartes archivées : c'est ce qui permet à l'historique
                    // d'ouvrir un bloc en lecture seule sans second aller-retour.
                    withSecrecy(() => ws.send('project.board', { projectId: project.id, archived: true }))
                ]);
                setColumns(board.columns);
                setCards(board.cards);
                setMilestones(plan.milestones);
                setDeps(plan.deps);
                setArchivedCards(archived.cards);
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
            await ws.send('project.cardMove', { columnId, cardIds });
            invalidate('project.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    const submitCard = async (draft: ProjectCardDraft) => {
        if (!cardDialog) return;
        setBusy(true);
        setDialogError(null);
        try {
            await withSecrecy(() =>
                cardDialog.card
                    ? ws.send('project.cardUpdate', { cardId: cardDialog.card.id, card: draft })
                    : ws.send('project.cardAdd', { projectId: project.id, columnId: cardDialog.columnId, card: draft })
            );
            invalidate('project.board', 'project.list');
            setCardDialog(null);
        } catch (e) {
            setDialogError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const archiveCard = async () => {
        if (!cardDialog?.card) return;
        setBusy(true);
        try {
            await withSecrecy(() => ws.send('project.cardArchive', { cardId: cardDialog.card!.id }));
            invalidate('project.board', 'project.list');
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
                    ? ws.send('project.columnUpdate', {
                          columnId: columnDialog.column.id,
                          name: result.name,
                          countsAsDone: result.countsAsDone,
                          wipLimit: result.wipLimit
                      })
                    : ws.send('project.columnAdd', { projectId: project.id, name: result.name })
            );
            invalidate('project.board', 'project.list');
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
            await ws.send('project.columnRemove', { columnId: columnDialog.column.id });
            invalidate('project.board', 'project.list');
            setColumnDialog(null);
        } catch (e) {
            // Le serveur refuse tant que la colonne porte des cartes : son
            // message dit exactement combien, on l'affiche tel quel.
            setDialogError(humanizeError(e, 'Le retrait a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const addDep = async (blockedByCardId: number) => {
        if (!cardDialog?.card) return;
        try {
            await ws.send('project.depAdd', { cardId: cardDialog.card.id, blockedByCardId });
            invalidate('project.board');
        } catch (e) {
            // Le serveur refuse les cycles avec un message explicite : on le
            // montre tel quel plutôt qu'un « échec » qui n'apprendrait rien.
            setDialogError(humanizeError(e, 'La dépendance n’a pas pu être ajoutée.'));
        }
    };

    const removeDep = async (blockedByCardId: number) => {
        if (!cardDialog?.card) return;
        try {
            await ws.send('project.depRemove', { cardId: cardDialog.card.id, blockedByCardId });
            invalidate('project.board');
        } catch (e) {
            setDialogError(humanizeError(e, 'Le retrait a échoué.'));
        }
    };

    const setCardMilestone = async (milestoneId: number | null) => {
        if (!cardDialog?.card) return;
        try {
            await ws.send('project.cardSetMilestone', { cardId: cardDialog.card.id, milestoneId });
            // La carte affichée porte le jalon : sans cette mise à jour locale,
            // le sélecteur reviendrait à l'ancienne valeur jusqu'au re-fetch.
            setCardDialog({ ...cardDialog, card: { ...cardDialog.card, milestoneId } });
            invalidate('project.board');
        } catch (e) {
            setDialogError(humanizeError(e, 'Le rattachement a échoué.'));
        }
    };

    const restoreArchivedCard = async () => {
        if (!archivedView) return;
        setBusy(true);
        try {
            await withSecrecy(() => ws.send('project.cardRestore', { cardId: archivedView.id }));
            invalidate('project.board', 'project.list');
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
                    ? ws.send('project.milestoneUpdate', {
                          milestoneId: milestoneDialog.milestone.id,
                          milestone: draft
                      })
                    : ws.send('project.milestoneAdd', { projectId: project.id, milestone: draft })
            );
            invalidate('project.board');
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
            const res = await ws.send('project.milestoneSetReached', {
                milestoneId: milestoneDialog.milestone.id,
                reached
            });
            setMilestoneDialog({ milestone: res.milestone });
            invalidate('project.board');
        } catch (e) {
            setDialogError(humanizeError(e, 'La mise à jour a échoué.'));
        }
    };

    const removeMilestone = async () => {
        if (!milestoneDialog?.milestone) return;
        setBusy(true);
        try {
            const id = milestoneDialog.milestone.id;
            await withSecrecy(() => ws.send('project.milestoneRemove', { milestoneId: id }));
            invalidate('project.board');
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
            await ws.send('project.columnReorder', { projectId: project.id, columnIds: ids });
        } catch (e) {
            setError(humanizeError(e, 'Le déplacement a échoué.'));
            void reload();
        }
    };

    return (
        <div className={styles.root}>
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
                    </div>
                </div>
                {canWrite && (
                    <Button variant='secondary' icon='edit' onClick={onEditProfile}>
                        Modifier le projet
                    </Button>
                )}
            </header>

            <nav className={styles.tabs}>
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type='button'
                        className={t.id === tab ? styles.tabActive : styles.tab}
                        aria-current={t.id === tab ? 'page' : undefined}
                        onClick={() => setTab(t.id)}
                    >
                        <span className={`icon icon-${t.icon}`} /> {t.label}
                    </button>
                ))}
            </nav>

            {/* Métadonnée de projet, donc hors des onglets : elle vaut quel que
                soit ce qu'on regarde. En repli, car c'est du contexte. */}
            <Links projectId={project.id} canWrite={canWrite} />

            {error && <p className={styles.error}>{error}</p>}
            {!loaded && <p className={styles.empty}>Chargement…</p>}

            {loaded && tab === 'board' && (
                <Board
                    columns={columns}
                    cards={cards}
                    members={members}
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
                    members={members}
                    canWrite={canWrite}
                    onCardOpen={(card) => {
                        setDialogError(null);
                        setCardDialog({ card, columnId: card.columnId });
                    }}
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

            {loaded && tab === 'git' && <Git project={project} members={members} canWrite={canWrite} />}

            {loaded && tab === 'deploy' && <Deploy project={project} members={members} canWrite={canWrite} />}

            {loaded && tab === 'history' && (
                <History
                    projectId={project.id}
                    members={members}
                    archivedCards={archivedCards}
                    onOpenArchived={(card) => setArchivedView(card)}
                />
            )}

            <ArchivedCardDialog
                open={archivedView !== null}
                card={archivedView}
                members={members}
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
                onSubmit={(draft) => void submitCard(draft)}
                onArchive={cardDialog?.card ? () => void archiveCard() : undefined}
                onDepAdd={(blockedByCardId) => void addDep(blockedByCardId)}
                onDepRemove={(blockedByCardId) => void removeDep(blockedByCardId)}
                onSetMilestone={(milestoneId) => void setCardMilestone(milestoneId)}
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
