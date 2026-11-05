import '@excalidraw/excalidraw/index.css';
import './theme.css';

import {
    CaptureUpdateAction,
    Excalidraw,
    exportToBlob,
    hashElementsVersion,
    MainMenu,
    reconcileElements,
    restoreElements
} from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
    BinaryFileData,
    Collaborator,
    DataURL,
    ExcalidrawImperativeAPI,
    SocketId
} from '@excalidraw/excalidraw/types';
import { useRef } from 'react';

import { PREVIEW_MAX_CHARS, type SceneElement, type WhiteboardPointer } from '../../contracts/domain';
import type { RemotePeer, SceneBridge } from '../session';

/** Ce que l'en-tête demande à l'éditeur, hors de la séance. */
export interface HostTools {
    /** Une vignette de la scène, ou `null` quand elle est vide ou trop lourde. */
    preview(): Promise<string | null>;
    /** Après une animation de la popup : Excalidraw mesure sa place au montage. */
    refresh(): void;
}

export interface HostProps {
    initialElements: readonly SceneElement[];
    title: string;
    canWrite: boolean;
    theme: 'light' | 'dark';
    onReady(bridge: SceneBridge, tools: HostTools): void;
    onSceneChange(): void;
    onSelection(ids: string[]): void;
    onPointer(pointer: WhiteboardPointer, button: 'up' | 'down'): void;
}

const asOrdered = (elements: readonly SceneElement[]) => elements as unknown as readonly OrderedExcalidrawElement[];

function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Excalidraw, réglé pour ne rien demander à personne d'autre que DevEye : ni
 * intégrations web, ni bibliothèque publique, ni IA, ni liens vers ses réseaux.
 * Chargé à la demande, avec ses polices et sa feuille de style.
 */
export default function Host(props: HostProps) {
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const lastVersion = useRef<number | null>(null);
    const lastSelection = useRef('');
    const propsRef = useRef(props);
    propsRef.current = props;

    const ready = (api: ExcalidrawImperativeAPI): void => {
        apiRef.current = api;
        const bridge: SceneBridge = {
            elements: () => api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[],
            merge(remote) {
                const local = api.getSceneElementsIncludingDeleted();
                const restored = restoreElements(
                    asOrdered(remote) as never,
                    null
                ) as unknown as readonly RemoteExcalidrawElement[];
                api.updateScene({
                    elements: reconcileElements(local, restored, api.getAppState()),
                    captureUpdate: CaptureUpdateAction.NEVER
                });
            },
            peers(peers: readonly RemotePeer[]) {
                const collaborators = new Map<SocketId, Collaborator>();
                for (const peer of peers) {
                    // Excalidraw tire la couleur d'un participant de son `id` : une par onglet.
                    collaborators.set(peer.clientId as SocketId, {
                        id: peer.clientId,
                        socketId: peer.clientId as SocketId,
                        username: peer.canWrite ? peer.name : `${peer.name} (lecture seule)`,
                        button: peer.button,
                        selectedElementIds: Object.fromEntries(peer.selectedIds.map((id) => [id, true])),
                        ...(peer.pointer ? { pointer: peer.pointer } : {})
                    });
                }
                api.updateScene({ collaborators });
            },
            file(id) {
                const file = api.getFiles()[id];
                return file ? { mimeType: file.mimeType, dataURL: file.dataURL } : null;
            },
            addFiles(files) {
                api.addFiles(
                    files.map(
                        (f) =>
                            ({
                                id: f.id,
                                mimeType: f.mimeType,
                                dataURL: f.dataURL as DataURL,
                                created: f.created
                            }) as BinaryFileData
                    )
                );
            }
        };
        const tools: HostTools = {
            async preview() {
                const elements = api.getSceneElements();
                if (elements.length === 0) return null;
                for (const size of [480, 320, 200]) {
                    const blob = await exportToBlob({
                        elements,
                        files: api.getFiles(),
                        appState: { exportBackground: true, exportWithDarkMode: false },
                        mimeType: 'image/webp',
                        quality: 0.7,
                        maxWidthOrHeight: size
                    });
                    const dataURL = await readAsDataUrl(blob);
                    if (dataURL.length <= PREVIEW_MAX_CHARS && /^data:image\/(png|webp);base64,/.test(dataURL)) {
                        return dataURL;
                    }
                }
                return null;
            },
            refresh: () => api.refresh()
        };
        propsRef.current.onReady(bridge, tools);
    };

    return (
        <Excalidraw
            excalidrawAPI={ready}
            initialData={{ elements: asOrdered(props.initialElements) as never, scrollToContent: true }}
            isCollaborating
            langCode='fr-FR'
            theme={props.theme}
            name={props.title}
            viewModeEnabled={!props.canWrite}
            validateEmbeddable={false}
            aiEnabled={false}
            handleKeyboardGlobally={false}
            UIOptions={{
                canvasActions: {
                    loadScene: false,
                    saveToActiveFile: false,
                    toggleTheme: null,
                    changeViewBackgroundColor: false,
                    clearCanvas: props.canWrite,
                    export: { saveFileToDisk: true },
                    saveAsImage: true
                },
                tools: { image: props.canWrite }
            }}
            onChange={(elements, appState) => {
                const version = hashElementsVersion(elements);
                if (version !== lastVersion.current) {
                    // La première passe est la scène reçue : rien à renvoyer.
                    if (lastVersion.current !== null) propsRef.current.onSceneChange();
                    lastVersion.current = version;
                }
                const selection = Object.keys(appState.selectedElementIds).filter(
                    (id) => appState.selectedElementIds[id]
                );
                const key = selection.join();
                if (key !== lastSelection.current) {
                    lastSelection.current = key;
                    propsRef.current.onSelection(selection);
                }
            }}
            onPointerUpdate={({ pointer, button }) => propsRef.current.onPointer(pointer, button)}
            onLinkOpen={(element, event) => {
                // Un lien vers un autre élément du tableau reste à Excalidraw ; le
                // reste s'ouvre à part, sans donner la main sur cette page.
                const link = element.link ?? '';
                if (link.startsWith('#') || link.includes('?element=')) return;
                event.preventDefault();
                if (/^https?:\/\//i.test(link)) window.open(link, '_blank', 'noopener,noreferrer');
            }}
        >
            <MainMenu>
                <MainMenu.DefaultItems.Export />
                <MainMenu.DefaultItems.SaveAsImage />
                <MainMenu.DefaultItems.SearchMenu />
                {props.canWrite && <MainMenu.DefaultItems.ClearCanvas />}
                <MainMenu.DefaultItems.Help />
            </MainMenu>
        </Excalidraw>
    );
}
