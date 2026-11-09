import { useEffect, useState } from 'react';
import { WHITEBOARD_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { WhiteboardClientProvider, WhiteboardLinkedCandidate } from '@deveye/types/sdk/client';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    moduleClientProvider,
    SearchSelect,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkBoardDialogProps {
    open: boolean;
    projectId: number;
    /** Les tableaux déjà reliés : ils sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter un tableau blanc au projet : en choisir un de l'espace, ou en créer
 * un par le dialogue de la feature (`BoardDialog`, par le contrat client du
 * Tableau blanc). Module absent, rien n'est proposé.
 */
export function LinkBoardDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkBoardDialogProps) {
    const provider = moduleClientProvider<WhiteboardClientProvider>(WHITEBOARD_CLIENT_PROVIDER);
    const [boards, setBoards] = useState<readonly WhiteboardLinkedCandidate[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    /** Le dialogue de création de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!provider) return;
        void (async () => {
            try {
                setBoards(await provider.listBoards());
            } catch (e) {
                setError(errorNote(e, 'Impossible de charger les tableaux de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = boards.filter((b) => !linkedIds.includes(b.id));

    const link = async (boardId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.whiteboardLink', { projectId, boardId });
            onSaved();
        } catch (e) {
            setError(errorNote(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open && !createOpen}
                onClose={onClose}
                title='Ajouter un tableau blanc au projet'
                width={560}
                onSubmit={() => picked !== '' && void link(Number(picked))}
                footer={
                    <>
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void link(Number(picked))} disabled={busy || picked === ''}>
                            {busy ? 'Enregistrement…' : 'Relier'}
                        </Button>
                    </>
                }
            >
                <div className={styles.form}>
                    {!provider ? (
                        <p className={styles.hint}>Le module Tableau blanc n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>Tableau de l’espace</span>
                                <SearchSelect
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={setPicked}
                                    options={free.map((board) => ({
                                        value: String(board.id),
                                        label: `${board.name}${board.foreign ? ' (partagé)' : ''}`
                                    }))}
                                    placeholder={
                                        free.length === 0
                                            ? boards.length === 0
                                                ? 'Aucun tableau n’existe encore dans cet espace'
                                                : 'Tous les tableaux de l’espace sont déjà reliés'
                                            : 'Choisir un tableau…'
                                    }
                                    aria-label='Tableau de l’espace'
                                />
                                <span className={styles.hint}>
                                    Un tableau peut servir plusieurs projets : en choisir un déjà relié ailleurs ne le
                                    retire à personne.
                                </span>
                            </label>

                            <div className={styles.actions}>
                                <Button
                                    variant='secondary'
                                    icon='add'
                                    onClick={() => setCreateOpen(true)}
                                    disabled={busy}
                                >
                                    Créer un tableau
                                </Button>
                                <span className={styles.hint}>
                                    Il rejoindra la feature « Tableau blanc », où vous le dessinerez, et sera relié à ce
                                    projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    <ErrorNote note={error} />
                </div>
            </Dialog>

            {/* Ce qu'il crée est relié dans la foulée. */}
            {provider && (
                <provider.BoardDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(boardId) => {
                        setCreateOpen(false);
                        void link(boardId);
                    }}
                />
            )}
        </>
    );
}

export default LinkBoardDialog;
