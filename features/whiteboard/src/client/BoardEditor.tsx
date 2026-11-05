import './excalidraw/assetPath';

import {
    ActionMenu,
    Button,
    ErrorNote,
    errorNote,
    FeatureSettingsButton,
    invalidate,
    LoadingVeil,
    StickyHeader,
    TextInput,
    useColorScheme,
    useDismissLayer,
    useRequestPopupWidth,
    useSuppressLiveCursors,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import type { BoardSummary } from '../contracts/domain';
import { api } from './api';
import type { HostTools } from './excalidraw/Host';
import { useBoardSession, type SceneBridge, type SessionStatus } from './session';
import styles from './style.module.css';
import { displayTitle, type BoardActions } from './Whiteboard';

/** Excalidraw et ses dépendances ne se chargent qu'à l'ouverture d'un tableau. */
const Host = lazy(() => import('./excalidraw/Host'));

const PREVIEW_EVERY_MS = 2 * 60_000;

const STATUS: Record<SessionStatus, { label: string; tone: 'ok' | 'busy' | 'warn' }> = {
    joining: { label: 'Connexion…', tone: 'busy' },
    synced: { label: 'Enregistré', tone: 'ok' },
    // Rien pendant qu'on dessine : « Enregistré » revient une fois au calme.
    sending: { label: '', tone: 'busy' },
    offline: { label: 'Hors ligne : reprise au retour du réseau', tone: 'warn' },
    quota: { label: 'Limite de stockage atteinte : les ajouts ne sont plus enregistrés', tone: 'warn' },
    tooLarge: { label: 'Tableau trop volumineux : les ajouts ne sont plus enregistrés', tone: 'warn' },
    saveFailed: { label: 'Échec d’enregistrement : nouvel essai en cours', tone: 'warn' }
};

const CLOSED = {
    removed: 'Ce tableau a été supprimé.',
    moved: 'Ce tableau a été déplacé vers un autre espace.'
} as const;

/**
 * Un tableau ouvert : son en-tête (retour, titre, état, participants, gestes)
 * et Excalidraw sur toute la place qui reste. La vue fait la hauteur de la
 * popup : un canevas ne défile pas, il se déplace.
 */
export default function BoardEditor({
    boardId,
    board,
    canWriteRole,
    actions,
    actionError,
    onBack
}: {
    boardId: number;
    board: BoardSummary | undefined;
    canWriteRole: boolean;
    actions: BoardActions;
    actionError: ErrorNoteInput | null;
    onBack(): void;
}) {
    const [view, session] = useBoardSession(boardId);
    const theme = useColorScheme();
    const canWrite = view.canWrite && canWriteRole;
    const title = board ? displayTitle(board) : (view.initial?.title.trim() ?? '') || 'Sans titre';
    const [draft, setDraft] = useState<string | null>(null);
    const [renameError, setRenameError] = useState<ErrorNoteInput | null>(null);
    const tools = useRef<HostTools | null>(null);
    const drawnSincePreview = useRef(false);
    const canWriteRef = useRef(canWrite);
    canWriteRef.current = canWrite;

    useSuppressLiveCursors();
    useRequestPopupWidth(1600);
    // Échap sert à Excalidraw (désélectionner, quitter un outil) : il ne ferme pas la vue.
    useDismissLayer(true, null);

    const savePreview = useCallback(async () => {
        if (!drawnSincePreview.current || tools.current === null || !canWriteRef.current) return;
        drawnSincePreview.current = false;
        try {
            const dataURL = await tools.current.preview();
            if (dataURL === null) return;
            await api.send('whiteboard.setPreview', { boardId, dataURL });
            invalidate('whiteboard.list');
        } catch {
            // Un aperçu manqué n'empêche rien : le suivant le remplacera.
        }
    }, [boardId]);

    useEffect(() => {
        const timer = setInterval(() => void savePreview(), PREVIEW_EVERY_MS);
        return () => {
            clearInterval(timer);
            void savePreview();
        };
    }, [savePreview]);

    const onReady = useCallback(
        (bridge: SceneBridge, hostTools: HostTools) => {
            session.bind(bridge);
            tools.current = hostTools;
            // La popup s'ouvre par une animation qui fausse la mesure prise au montage.
            setTimeout(() => hostTools.refresh(), 450);
        },
        [session]
    );

    const commitTitle = (): void => {
        if (draft === null) return;
        const next = draft.trim();
        setDraft(null);
        if (next === (board?.title ?? '').trim()) return;
        setRenameError(null);
        api.send('whiteboard.rename', { boardId, title: next })
            .then(() => invalidate('whiteboard.list'))
            .catch((e: unknown) => setRenameError(errorNote(e, 'Le tableau n’a pas pu être renommé.')));
    };

    const back = (): void => {
        void savePreview();
        onBack();
    };

    if (view.closed !== null) {
        return (
            <div className={styles.root}>
                <StickyHeader>
                    <header className={styles.header}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Tableaux
                        </Button>
                    </header>
                </StickyHeader>
                <p className={styles.emptyText}>{CLOSED[view.closed]}</p>
            </div>
        );
    }

    const status = canWrite ? STATUS[view.status] : { label: 'Lecture seule', tone: 'ok' as const };
    return (
        <div className={styles.editor}>
            <StickyHeader>
                <header className={styles.editorHeader}>
                    <Button variant='ghost' icon='arrow-left' onClick={back}>
                        Tableaux
                    </Button>
                    {canWrite ? (
                        <TextInput
                            className={styles.titleInput}
                            aria-label='Titre du tableau'
                            placeholder='Sans titre'
                            maxLength={200}
                            value={draft ?? board?.title ?? ''}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitTitle}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                        />
                    ) : (
                        <h2 className={styles.editorTitle}>{title}</h2>
                    )}
                    <span className={styles.status} data-tone={status.tone} role='status'>
                        {status.label}
                    </span>
                    <span className={styles.editorActions}>
                        <FeatureSettingsButton
                            variant='ghost'
                            scope={{ kind: 'item', feature: 'whiteboard', itemId: String(boardId), itemLabel: title }}
                            onGone={onBack}
                        />
                        {canWrite && board && (
                            <ActionMenu
                                label='Actions sur ce tableau'
                                items={[
                                    { label: 'Dupliquer', icon: 'copy', onSelect: () => actions.duplicate(board) },
                                    ...(board.foreign
                                        ? []
                                        : [
                                              {
                                                  label: 'Supprimer',
                                                  icon: 'trash',
                                                  danger: true,
                                                  onSelect: () => actions.remove(board, onBack)
                                              }
                                          ])
                                ]}
                            />
                        )}
                    </span>
                </header>
            </StickyHeader>
            <ErrorNote note={renameError ?? actionError ?? view.error} />
            <div className={styles.canvas}>
                {view.initial === null ? (
                    <LoadingVeil label='Ouverture du tableau…' />
                ) : (
                    <Suspense fallback={<LoadingVeil label='Chargement de l’éditeur…' />}>
                        <Host
                            initialElements={view.initial.elements}
                            title={title}
                            canWrite={canWrite}
                            theme={theme}
                            onReady={onReady}
                            onSceneChange={() => {
                                drawnSincePreview.current = true;
                                session.changed();
                            }}
                            onSelection={(ids) => session.selection(ids)}
                            onPointer={(pointer, button) => session.pointer(pointer, button)}
                        />
                    </Suspense>
                )}
            </div>
        </div>
    );
}
