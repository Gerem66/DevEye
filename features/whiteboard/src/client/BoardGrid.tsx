import {
    ActionMenu,
    Button,
    ErrorNote,
    errorNote,
    formatBytesFr,
    invalidate,
    pickFiles,
    StickyHeader,
    UsageMeter,
    useLiveOutlines,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useState, type ReactNode } from 'react';

import type { BoardSummary } from '../contracts/domain';
import { api } from './api';
import { EXCALIDRAW_SOURCE, updatedLabel } from './format';
import { parseExcalidraw } from './importFile';
import styles from './style.module.css';
import { displayTitle, type BoardActions } from './Whiteboard';

/** À partir d'où l'usage se montre : avant, le quota n'a rien à dire. */
const SHOW_USAGE_AT = 0.8;

/** Les aperçus, relus seulement quand leur version a changé. */
function usePreviews(boards: readonly BoardSummary[]): ReadonlyMap<number, string> {
    const [cache, setCache] = useState(new Map<number, { version: number; dataURL: string }>());
    const stale = boards
        .filter((b) => b.hasPreview && cache.get(b.id)?.version !== b.previewVersion)
        .map((b) => b.id)
        .slice(0, 50);
    const key = stale.join();
    useEffect(() => {
        if (stale.length === 0) return;
        let alive = true;
        const versions = new Map(boards.map((b) => [b.id, b.previewVersion]));
        api.send('whiteboard.previews', { boardIds: stale })
            .then(({ previews }) => {
                if (!alive) return;
                setCache((prev) => {
                    const next = new Map(prev);
                    for (const p of previews)
                        next.set(p.boardId, { version: versions.get(p.boardId) ?? 0, dataURL: p.dataURL });
                    return next;
                });
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
        // `key` résume `stale` : relire à chaque rendu redemanderait les mêmes.
    }, [key]);
    return new Map([...cache].map(([id, entry]) => [id, entry.dataURL]));
}

export default function BoardGrid({
    boards,
    loaded,
    usage,
    canWrite,
    actions,
    onOpen,
    errors
}: {
    boards: readonly BoardSummary[];
    loaded: boolean;
    usage: { used: number; limit: number } | null;
    canWrite: boolean;
    actions: BoardActions;
    onOpen(id: number): void;
    errors: ReactNode;
}) {
    const outlineOf = useLiveOutlines('l1');
    const previews = usePreviews(boards);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const create = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            const { board } = await api.send('whiteboard.add', { title: '' });
            invalidate('whiteboard.list', 'whiteboard.count');
            onOpen(board.id);
        } catch (e) {
            setError(errorNote(e, 'Le tableau n’a pas pu être créé.'));
        } finally {
            setBusy(false);
        }
    };

    const importFile = async (): Promise<void> => {
        const [picked] = await pickFiles({ accept: '.excalidraw,application/json' });
        if (!picked) return;
        setBusy(true);
        setError(null);
        try {
            const parsed = parseExcalidraw(picked.file.name, await picked.file.text());
            const { board } = await api.send(
                'whiteboard.add',
                {
                    title: parsed.title,
                    elements: parsed.elements,
                    filesBytes: parsed.filesBytes,
                    appearance: parsed.appearance
                },
                { timeoutMs: 60_000 }
            );
            for (const file of parsed.files) {
                await api.send(
                    'whiteboard.fileAdd',
                    { boardId: board.id, fileId: file.id, mimeType: file.mimeType, dataURL: file.dataURL },
                    { timeoutMs: 120_000 }
                );
            }
            invalidate('whiteboard.list', 'whiteboard.count');
            onOpen(board.id);
        } catch (e) {
            setError(errorNote(e, 'Ce fichier n’a pas pu être importé.'));
        } finally {
            setBusy(false);
        }
    };

    const showUsage = usage !== null && usage.limit > 0 && usage.used >= usage.limit * SHOW_USAGE_AT;
    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div>
                        <h2 className={styles.heading}>Tableau blanc</h2>
                        <p className={styles.subheading}>
                            Des schémas à main levée, dessinés à plusieurs en même temps.
                        </p>
                    </div>
                    {canWrite && (
                        <div className={styles.actions}>
                            <Button variant='secondary' icon='upload' disabled={busy} onClick={() => void importFile()}>
                                Importer
                            </Button>
                            <Button icon='add' disabled={busy} onClick={() => void create()}>
                                Nouveau tableau
                            </Button>
                        </div>
                    )}
                </header>
            </StickyHeader>

            {errors}
            <ErrorNote note={error} />
            {showUsage && (
                <UsageMeter
                    used={usage.used}
                    limit={usage.limit}
                    label='Stockage des tableaux'
                    explain='Les images collées dans les tableaux comptent presque seules : un dessin sans image pèse quelques kilo-octets.'
                    format={formatBytesFr}
                />
            )}

            {!loaded ? null : boards.length === 0 ? (
                <div className={styles.emptyState}>
                    <p className={styles.emptyTitle}>Aucun tableau pour l’instant</p>
                    <p className={styles.emptyText}>
                        Un tableau blanc sert à poser une idée en quelques traits : un schéma d’architecture, un
                        parcours, une maquette d’écran. Les membres de l’espace y dessinent en même temps et voient le
                        pointeur des autres.
                    </p>
                    {canWrite ? (
                        <Button icon='add' disabled={busy} onClick={() => void create()}>
                            Nouveau tableau
                        </Button>
                    ) : (
                        <p className={styles.emptyText}>
                            Un membre autorisé à modifier le tableau blanc peut en créer un.
                        </p>
                    )}
                </div>
            ) : (
                <ul className={styles.grid}>
                    {boards.map((board) => {
                        const preview = previews.get(board.id);
                        return (
                            <li key={board.id} className={styles.card} {...outlineOf(String(board.id))}>
                                <button type='button' className={styles.cardOpen} onClick={() => onOpen(board.id)}>
                                    <span className={styles.preview}>
                                        {preview ? (
                                            <img
                                                src={preview}
                                                alt=''
                                                className={styles.previewImage}
                                                data-theme={board.theme ?? undefined}
                                            />
                                        ) : (
                                            <span
                                                className={`icon icon-whiteboard ${styles.previewIcon}`}
                                                aria-hidden='true'
                                            />
                                        )}
                                    </span>
                                    <span className={styles.cardTitle}>{displayTitle(board)}</span>
                                    <span className={styles.cardMeta}>
                                        {board.foreign ? 'Partagé depuis un autre espace · ' : ''}
                                        {updatedLabel(board.updatedAt)}
                                    </span>
                                </button>
                                {canWrite && (
                                    <div className={styles.cardMenu}>
                                        <ActionMenu
                                            label={`Actions sur « ${displayTitle(board)} »`}
                                            items={[
                                                {
                                                    label: 'Dupliquer',
                                                    icon: 'copy',
                                                    onSelect: () => actions.duplicate(board)
                                                },
                                                ...(board.foreign
                                                    ? []
                                                    : [
                                                          {
                                                              label: 'Supprimer',
                                                              icon: 'trash',
                                                              danger: true,
                                                              onSelect: () => actions.remove(board)
                                                          }
                                                      ])
                                            ]}
                                        />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            <p className={styles.credit}>
                L’éditeur est{' '}
                <a href={EXCALIDRAW_SOURCE} target='_blank' rel='noopener noreferrer' className={styles.creditLink}>
                    Excalidraw
                </a>
                , un logiciel libre sous licence MIT.
            </p>
        </div>
    );
}
