import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    invalidate,
    moduleClientProvider,
    useResourceVersion,
    useWorkspacePermissions,
    WsError,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { api } from '../api';
import type { Project, ProjectLinkLabel } from '../../contracts/domain';
import { WHITEBOARD_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { WhiteboardClientProvider, WhiteboardLinkedCandidate } from '@deveye/types/sdk/client';
import { LinkBoardDialog } from './LinkBoardDialog';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface WhiteboardsProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Tableaux blancs » d'un projet : les tableaux qu'il rattache. Le
 * tableau n'appartient pas au projet, qui n'en tient qu'un pointeur ;
 * l'affichage vient du bloc du module (`WHITEBOARD_CLIENT_PROVIDER`).
 *
 * Lire un tableau relève du droit `whiteboard`, pas de `projects` : sans lui,
 * ou sans le module, les tableaux se listent en identifiants nus.
 */
export function Whiteboards({ project, canWrite }: WhiteboardsProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<WhiteboardClientProvider>(WHITEBOARD_CLIENT_PROVIDER);
    const canReadBoards = permissions.canFeature('whiteboard');
    const canWriteBoards = permissions.canFeature('whiteboard', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    /** Les tableaux nommés par le serveur : ce qu'un projet projeté en montre. */
    const [labels, setLabels] = useState<readonly ProjectLinkLabel[]>([]);
    /** Les tableaux de l'espace, pour nommer celui qu'on délie. */
    const [candidates, setCandidates] = useState<readonly WhiteboardLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** Le tableau qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);
    /** L'échec du déliement, dit dans la confirmation qui reste ouverte. */
    const [unlinkError, setUnlinkError] = useState<ErrorNoteInput | null>(null);

    const boardVersion = useResourceVersion('projects.board');
    const listVersion = useResourceVersion('whiteboard.list');
    const guarded = project.securityTier === 'guarded';
    const foreign = project.foreign;

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await api.send('projects.whiteboardList', { projectId: project.id });
            setLinkedIds(res.boardIds);
            setLabels(res.labels);
            setError(null);
        } catch (e) {
            setError(errorNote(e, 'Impossible de charger les tableaux liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer le tableau qu'on délie. Sans le droit (ou sans
    // le module), on s'arrête aux pointeurs plutôt que d'encaisser un refus.
    useEffect(() => {
        if (guarded || foreign || !canReadBoards || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listBoards();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(errorNote(e, 'Impossible de charger les tableaux de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, foreign, canReadBoards, provider, listVersion]);

    const unlink = async (boardId: number) => {
        setBusy(true);
        setUnlinkError(null);
        try {
            await api.send('projects.whiteboardUnlink', { projectId: project.id, boardId });
            setUnlinking(null);
            invalidate('projects.board');
        } catch (e) {
            setUnlinkError(errorNote(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const closeUnlink = () => {
        setUnlinking(null);
        setUnlinkError(null);
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à un tableau blanc. Les tableaux vivent sous la
                clé de l’espace, et leur séance de dessin tourne sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    // Projeté depuis un autre espace : les tableaux se nomment, sans le bloc du
    // module ni ses gestes (voir `ForeignLinks`).
    if (foreign) {
        return (
            <div className={styles.linkedSites}>
                <ErrorNote note={error} />
                {!provider && <p className={styles.hint}>Le module Tableau blanc n’est pas installé.</p>}
                <ForeignLinks labels={labels} empty='Aucun tableau blanc relié à ce projet.' />
            </div>
        );
    }

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedSites}>
            <ErrorNote note={error} />
            {!provider && <p className={styles.hint}>Le module Tableau blanc n’est pas installé.</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucun tableau blanc relié à ce projet.</p>}

            {linkedIds.length > 0 && !canReadBoards && (
                <p className={styles.empty}>
                    Ce projet rattache {linkedIds.length} tableau{linkedIds.length > 1 ? 'x' : ''} blanc
                    {linkedIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre pas la feature « Tableau blanc ».
                </p>
            )}

            {canReadBoards &&
                linkedIds.map((id) =>
                    provider ? (
                        <provider.LinkedBoard
                            key={id}
                            boardId={id}
                            canWrite={canWrite && canWriteBoards}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>Tableau #{id}</span>
                            {canWrite && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {canWrite && canWriteBoards && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un tableau blanc
                    </Button>
                </div>
            )}

            {canWrite && !canWriteBoards && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les tableaux blancs de cet espace.
                </span>
            )}

            <LinkBoardDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={linkedIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('projects.board', 'whiteboard.list', 'whiteboard.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={closeUnlink}
                title='Délier ce tableau blanc ?'
                width={460}
                onSubmit={() => unlinking !== null && void unlink(unlinking)}
                footer={
                    <>
                        <Button variant='secondary' onClick={closeUnlink} disabled={busy}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() => unlinking !== null && void unlink(unlinking)}
                        >
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    <strong>{unlinkingName ?? 'Ce tableau'}</strong> quitte ce projet. Le dessin, ses images et les
                    autres projets qui le rattachent ne sont pas touchés.
                </p>
                <ErrorNote note={unlinkError} />
            </Dialog>
        </div>
    );
}

export default Whiteboards;
