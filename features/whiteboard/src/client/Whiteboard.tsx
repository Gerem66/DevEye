import {
    ConfirmDialog,
    ErrorNote,
    errorNote,
    invalidate,
    useActiveWorkspace,
    useLiveItemTarget,
    useResource,
    useSubView,
    useWorkspacePermissions,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import { useState } from 'react';

import type { BoardSummary } from '../contracts/domain';
import { api } from './api';
import BoardEditor from './BoardEditor';
import BoardGrid from './BoardGrid';

export interface BoardActions {
    duplicate(board: BoardSummary): void;
    remove(board: BoardSummary, then?: () => void): void;
}

export const displayTitle = (board: { title: string }): string => board.title.trim() || 'Sans titre';

/**
 * Les tableaux de l'espace, puis l'éditeur d'un tableau ouvert à la place de la
 * grille. La présence `l1` est le tableau ouvert : c'est ce que la téléportation
 * écrit, et ce qui met les participants d'une même séance au même chemin.
 */
export default function Whiteboard(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [actionError, setActionError] = useState<ErrorNoteInput | null>(null);

    const list = useResource(
        'whiteboard.list',
        () => api.send('whiteboard.list', {}),
        'Les tableaux n’ont pas pu être lus.',
        [workspaceId]
    );
    const boards = list.data?.boards ?? [];

    useLiveItemTarget('l1', openedId === null ? null : String(openedId), list.data !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (Number.isInteger(id) && boards.some((board) => board.id === id)) setOpenedId(id);
    });
    useSubView(openedId === null ? null : 'board');

    const actions: BoardActions = {
        duplicate(board) {
            setActionError(null);
            api.send('whiteboard.duplicate', { boardId: board.id }, { timeoutMs: 120_000 })
                .then(({ board: copy }) => {
                    invalidate('whiteboard.list', 'whiteboard.count');
                    setOpenedId(copy.id);
                })
                .catch((e: unknown) => setActionError(errorNote(e, 'Le tableau n’a pas pu être dupliqué.')));
        },
        remove(board, then) {
            setConfirm({
                title: `Supprimer « ${displayTitle(board)} » ?`,
                description: 'Le dessin et ses images sont effacés pour tous les membres. Cette action est définitive.',
                confirmLabel: 'Supprimer',
                onConfirm: () => {
                    setActionError(null);
                    api.send('whiteboard.remove', { boardId: board.id })
                        .then(() => {
                            invalidate('whiteboard.list', 'whiteboard.count');
                            then?.();
                        })
                        .catch((e: unknown) => setActionError(errorNote(e, 'Le tableau n’a pas pu être supprimé.')));
                }
            });
        }
    };

    const opened = openedId === null ? undefined : boards.find((board) => board.id === openedId);
    return (
        <>
            {openedId !== null ? (
                <BoardEditor
                    key={openedId}
                    boardId={openedId}
                    board={opened}
                    canWriteRole={permissions.canFeature('whiteboard', 'write', String(openedId))}
                    actions={actions}
                    actionError={actionError}
                    onBack={() => setOpenedId(null)}
                />
            ) : (
                <BoardGrid
                    boards={boards}
                    loaded={list.data !== null}
                    usage={list.data?.usage ?? null}
                    canWrite={permissions.canFeature('whiteboard', 'write')}
                    actions={actions}
                    onOpen={setOpenedId}
                    errors={
                        <>
                            <ErrorNote note={list.error} />
                            <ErrorNote note={actionError} />
                        </>
                    }
                />
            )}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}
