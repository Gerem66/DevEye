import type { SdkTileSummary, WhiteboardClientProvider } from '@deveye/types/sdk/client';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    FeatureSettingsButton,
    formatBytesFr,
    invalidate,
    openFeature,
    TextInput,
    useResource,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useState } from 'react';

import { WHITEBOARD_TITLE_MAX } from '../contracts/domain';
import { api } from './api';
import { sinceLabel, updatedLabel } from './format';
import styles from './style.module.css';
import { displayTitle } from './Whiteboard';

/**
 * Ce que le module offre à l'onglet « Tableaux blancs » d'un projet : la liste
 * des tableaux de l'espace, un tableau relié, et le dialogue de création.
 * Dessiner se fait dans l'éditeur, à un clic : un canevas ne tient pas dans un
 * onglet.
 */

/** L'aperçu d'un tableau, relu seulement quand sa version change. */
function usePreview(boardId: number, version: number | null): string | null {
    const [preview, setPreview] = useState<string | null>(null);
    useEffect(() => {
        if (version === null) {
            setPreview(null);
            return;
        }
        let alive = true;
        api.send('whiteboard.previews', { boardIds: [boardId] })
            .then(({ previews }) => {
                if (alive) setPreview(previews[0]?.dataURL ?? null);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [boardId, version]);
    return preview;
}

function LinkedBoard({ boardId, canWrite, onUnlink }: { boardId: number; canWrite: boolean; onUnlink: () => void }) {
    const list = useResource(
        'whiteboard.list',
        () => api.send('whiteboard.list', {}),
        'Les tableaux n’ont pas pu être lus.',
        []
    );
    const board = list.data?.boards.find((candidate) => candidate.id === boardId) ?? null;
    const preview = usePreview(boardId, board?.hasPreview ? board.previewVersion : null);

    if (list.data === null) {
        return list.error === null ? <p className={styles.emptyText}>Chargement…</p> : <ErrorNote note={list.error} />;
    }
    if (board === null) {
        return (
            <section className={styles.linkedBoard} aria-label='Tableau disparu'>
                <div className={styles.linkedHead}>
                    <p className={styles.emptyText}>Ce tableau n’est plus visible dans cet espace.</p>
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink}>
                            Délier
                        </Button>
                    )}
                </div>
            </section>
        );
    }

    const title = displayTitle(board);
    return (
        <section className={styles.linkedBoard} aria-label={title}>
            <button
                type='button'
                className={styles.linkedPreview}
                onClick={() => openFeature('whiteboard', board.id)}
                aria-label={`Ouvrir « ${title} »`}
            >
                {preview ? (
                    <img src={preview} alt='' className={styles.previewImage} data-theme={board.theme ?? undefined} />
                ) : (
                    <span className={`icon icon-whiteboard ${styles.previewIcon}`} aria-hidden='true' />
                )}
            </button>
            <div className={styles.linkedHead}>
                <div className={styles.linkedText}>
                    <h3 className={styles.linkedTitle}>{title}</h3>
                    <p className={styles.cardMeta}>
                        {board.foreign ? 'Partagé depuis un autre espace · ' : ''}
                        {updatedLabel(board.updatedAt)}
                    </p>
                </div>
                <div className={styles.actions}>
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'whiteboard', itemId: String(board.id), itemLabel: title }}
                    />
                    <Button
                        variant='secondary'
                        icon='chevrons-right'
                        onClick={() => openFeature('whiteboard', board.id)}
                    >
                        Ouvrir le tableau
                    </Button>
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink}>
                            Délier
                        </Button>
                    )}
                </div>
            </div>
        </section>
    );
}

/** La création d'un tableau, nommé d'avance : Projets le relie dans la foulée. */
function BoardDialog({
    open,
    onClose,
    onSaved
}: {
    open: boolean;
    onClose: () => void;
    onSaved: (boardId: number) => void;
}) {
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (!open) return;
        setTitle('');
        setError(null);
    }, [open]);

    const create = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            const { board } = await api.send('whiteboard.add', { title: title.trim() });
            invalidate('whiteboard.list', 'whiteboard.count');
            onSaved(board.id);
        } catch (e) {
            setError(errorNote(e, 'Le tableau n’a pas pu être créé.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Nouveau tableau blanc'
            width={460}
            onSubmit={() => void create()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void create()} disabled={busy}>
                        {busy ? 'Création…' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Titre</span>
                    <TextInput
                        value={title}
                        maxLength={WHITEBOARD_TITLE_MAX}
                        placeholder='Sans titre'
                        onChange={(e) => setTitle(e.target.value)}
                        autoFocus
                    />
                </label>
                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

/** Un seul aller-retour, quel que soit le nombre de tuiles : la liste porte déjà les chiffres. */
async function summarize(boardIds: readonly number[]): Promise<readonly SdkTileSummary[]> {
    const { boards } = await api.send('whiteboard.list', {});
    return boardIds.map((id): SdkTileSummary => {
        const board = boards.find((candidate) => candidate.id === id);
        if (!board)
            return { itemId: id, title: 'Tableau supprimé', metrics: [], unavailable: 'Ce tableau n’est plus ici.' };
        return {
            itemId: id,
            title: displayTitle(board),
            metrics: [
                { key: 'updated', label: 'Modifié', value: sinceLabel(board.updatedAt) },
                { key: 'size', label: 'Taille', value: formatBytesFr(board.byteSize) }
            ]
        };
    });
}

export const clientProvider: WhiteboardClientProvider = {
    listBoards: async () =>
        (await api.send('whiteboard.list', {})).boards.map((board) => ({
            id: board.id,
            name: displayTitle(board),
            foreign: board.foreign
        })),
    summarize,
    LinkedBoard,
    BoardDialog
};
