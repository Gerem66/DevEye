import '@excalidraw/excalidraw/index.css';
import './theme.css';

import {
    CaptureUpdateAction,
    Excalidraw,
    exportToBlob,
    hashElementsVersion,
    MainMenu,
    reconcileElements,
    restoreElements,
    sceneCoordsToViewportCoords,
    viewportCoordsToSceneCoords
} from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
    AppState,
    BinaryFileData,
    Collaborator,
    DataURL,
    ExcalidrawImperativeAPI,
    SocketId
} from '@excalidraw/excalidraw/types';
import type { UserColor } from '@deveye/types';
import { useLiveCursorSurface, userColorVar, type LiveCursorSurface } from 'deveye-sdk-client';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PREVIEW_MAX_CHARS, type BoardAppearance, type SceneElement } from '../../contracts/domain';
import type { RemotePeer, SceneBridge } from '../session';
import { EXCALIDRAW_SOURCE } from '../format';
import { RemoteSelections, type PeerSelection } from './RemoteSelections';

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
    /** Celui du tableau, sinon celui du profil. */
    theme: 'light' | 'dark';
    appearance: BoardAppearance;
    /** Le canal des curseurs, une fois la séance rejointe. */
    channel: string | null;
    onReady(bridge: SceneBridge, tools: HostTools): void;
    onSceneChange(): void;
    onAppearance(patch: Partial<BoardAppearance>): void;
    onSelection(ids: string[]): void;
    onLaser(on: boolean): void;
}

const asOrdered = (elements: readonly SceneElement[]) => elements as unknown as readonly OrderedExcalidrawElement[];

/** Le sélecteur de thème d'Excalidraw n'a pas de libellé français : celui-ci en reprend la forme. */
const THEME_CHOICES: readonly { value: BoardAppearance['theme']; label: string; title: string }[] = [
    { value: null, label: 'Profil', title: 'Celui du profil de chaque participant' },
    { value: 'light', label: 'Clair', title: 'Clair pour tous' },
    { value: 'dark', label: 'Sombre', title: 'Sombre pour tous' }
];

/**
 * La scène comme surface des curseurs de DevEye : chacun s'y déplace et zoome à
 * sa guise, et un point de la scène désigne le même dessin chez tous. Le
 * canevas en est le cadre : hors de lui, le curseur n'est pas sur le tableau.
 */
function sceneSurface(api: ExcalidrawImperativeAPI, channel: string): LiveCursorSurface {
    const inside = (x: number, y: number, state: AppState): boolean =>
        x >= state.offsetLeft &&
        x <= state.offsetLeft + state.width &&
        y >= state.offsetTop &&
        y <= state.offsetTop + state.height;
    return {
        channel,
        fromScreen(clientX, clientY) {
            const state = api.getAppState();
            return inside(clientX, clientY, state) ? viewportCoordsToSceneCoords({ clientX, clientY }, state) : null;
        },
        toScreen(x, y) {
            const state = api.getAppState();
            const at = sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, state);
            return inside(at.x, at.y, state) ? at : null;
        },
        subscribe(onChange) {
            const stop = api.onScrollChange(onChange);
            window.addEventListener('resize', onChange);
            return () => {
                stop();
                window.removeEventListener('resize', onChange);
            };
        }
    };
}

/** La traînée laser d'Excalidraw veut une couleur, pas une variable : celle que le thème donne au compte. */
function resolvedColor(probe: HTMLElement, color: UserColor): string {
    probe.style.color = userColorVar(color);
    return getComputedStyle(probe).color;
}

/** Ce qui change les cadres : la séance repasse les participants à chaque position reçue pendant un laser. */
function selectionKey(peers: readonly PeerSelection[]): string {
    return peers.map((peer) => `${peer.clientId}:${peer.color}:${peer.selectedIds.join(',')}`).join('|');
}

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
    const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
    const [selections, setSelections] = useState<readonly PeerSelection[]>([]);
    const probe = useRef<HTMLSpanElement | null>(null);
    const host = useRef<HTMLDivElement | null>(null);
    const lastVersion = useRef<number | null>(null);
    const lastSelection = useRef('');
    const lastBackground = useRef<string | null>(null);
    const customBackground = useRef<HTMLInputElement | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    const background = props.appearance.background;
    useEffect(() => {
        const api = apiRef.current;
        if (api === null || background === null || api.getAppState().viewBackgroundColor === background) return;
        api.updateScene({ appState: { viewBackgroundColor: background }, captureUpdate: CaptureUpdateAction.NEVER });
    }, [background]);

    const surface = useMemo(
        () => (api !== null && props.channel !== null ? sceneSurface(api, props.channel) : null),
        [api, props.channel]
    );
    useLiveCursorSurface(surface);

    // Excalidraw trace le laser en coordonnées de la fenêtre, dans un calque en
    // `position: fixed` ; le verre de la popup (`backdrop-filter`) en fait le
    // repère de ce calque, qu'on ramène à l'origine de la fenêtre chaque fois
    // qu'Excalidraw remesure sa place.
    useEffect(() => {
        if (api === null) return;
        const shift = { x: 0, y: 0 };
        const align = (): void => {
            const layer = host.current?.querySelector<HTMLElement>('.SVGLayer');
            if (!layer) return;
            const at = layer.getBoundingClientRect();
            if (Math.abs(at.left) < 0.5 && Math.abs(at.top) < 0.5) return;
            shift.x -= at.left;
            shift.y -= at.top;
            layer.style.transform = `translate(${shift.x}px, ${shift.y}px)`;
        };
        align();
        return api.onChange(align);
    }, [api]);

    const ready = (api: ExcalidrawImperativeAPI): void => {
        apiRef.current = api;
        setApi(api);
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
                // Le curseur et la sélection sont dessinés par DevEye : Excalidraw ne garde
                // que la traînée laser, à la couleur du compte.
                const collaborators = new Map<SocketId, Collaborator>();
                for (const peer of peers) {
                    if (peer.pointer === null || probe.current === null) continue;
                    collaborators.set(peer.clientId as SocketId, {
                        id: peer.clientId,
                        socketId: peer.clientId as SocketId,
                        username: peer.name,
                        button: peer.laser ? 'down' : 'up',
                        pointer: {
                            ...peer.pointer,
                            tool: 'laser',
                            renderCursor: false,
                            laserColor: resolvedColor(probe.current, peer.color)
                        }
                    });
                }
                api.updateScene({ collaborators });
                const selected = peers.filter((peer) => peer.selectedIds.length > 0);
                setSelections((current) =>
                    selectionKey(current) === selectionKey(selected)
                        ? current
                        : selected.map(({ clientId, color, selectedIds }) => ({ clientId, color, selectedIds }))
                );
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
                        appState: {
                            exportBackground: true,
                            exportWithDarkMode: false,
                            viewBackgroundColor: api.getAppState().viewBackgroundColor
                        },
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
        <div ref={host} className='whiteboard-host'>
            <Excalidraw
                excalidrawAPI={ready}
                initialData={{
                    elements: asOrdered(props.initialElements) as never,
                    ...(background !== null ? { appState: { viewBackgroundColor: background } } : {}),
                    scrollToContent: true
                }}
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
                        changeViewBackgroundColor: props.canWrite,
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
                    // Un fond choisi ici, pas celui qu'on vient d'appliquer depuis ailleurs.
                    const color = appState.viewBackgroundColor;
                    if (
                        lastBackground.current !== null &&
                        color !== lastBackground.current &&
                        color !== propsRef.current.appearance.background
                    ) {
                        propsRef.current.onAppearance({ background: color });
                    }
                    lastBackground.current = color;
                    const selection = Object.keys(appState.selectedElementIds).filter(
                        (id) => appState.selectedElementIds[id]
                    );
                    const key = selection.join();
                    if (key !== lastSelection.current) {
                        lastSelection.current = key;
                        propsRef.current.onSelection(selection);
                    }
                }}
                onPointerUpdate={({ pointer, button }) =>
                    propsRef.current.onLaser(pointer.tool === 'laser' && button === 'down')
                }
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
                    <MainMenu.ItemLink href={EXCALIDRAW_SOURCE} target='_blank' rel='noopener noreferrer'>
                        À propos d’Excalidraw
                    </MainMenu.ItemLink>
                    {props.canWrite && (
                        <>
                            <MainMenu.Separator />
                            <div className='dropdown-menu-item-base dropdown-menu-item-bare'>
                                <span className='dropdown-menu-item__text'>Thème</span>
                                <div
                                    className='RadioGroup whiteboard-theme'
                                    role='radiogroup'
                                    aria-label='Thème du tableau'
                                >
                                    {THEME_CHOICES.map((choice) => (
                                        <div
                                            key={choice.label}
                                            className={`RadioGroup__choice${props.appearance.theme === choice.value ? ' active' : ''}`}
                                            title={choice.title}
                                        >
                                            <input
                                                name='whiteboard-theme'
                                                type='radio'
                                                aria-label={choice.title}
                                                checked={props.appearance.theme === choice.value}
                                                onChange={() => props.onAppearance({ theme: choice.value })}
                                            />
                                            {choice.label}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {/* Pour le fond, le carré de droite d'Excalidraw n'ouvre qu'un code hexadécimal :
                            il ouvre ici le sélecteur du système, où toute couleur se choisit. */}
                            <div
                                className='whiteboard-background'
                                onClickCapture={(event) => {
                                    const input = customBackground.current;
                                    if (
                                        !(event.target instanceof Element) ||
                                        !event.target.closest('.active-color') ||
                                        !input
                                    )
                                        return;
                                    event.stopPropagation();
                                    const current = apiRef.current?.getAppState().viewBackgroundColor ?? '';
                                    if (/^#[0-9a-f]{6}$/i.test(current)) input.value = current;
                                    input.showPicker();
                                }}
                            >
                                <MainMenu.DefaultItems.ChangeCanvasBackground />
                                <input
                                    type='color'
                                    tabIndex={-1}
                                    aria-hidden
                                    ref={(input) => {
                                        customBackground.current = input;
                                        // `change` et pas `input` : un seul enregistrement, quand le choix est fait.
                                        if (input)
                                            input.onchange = () =>
                                                apiRef.current?.updateScene({
                                                    appState: { viewBackgroundColor: input.value },
                                                    captureUpdate: CaptureUpdateAction.IMMEDIATELY
                                                });
                                    }}
                                />
                            </div>
                        </>
                    )}
                </MainMenu>
            </Excalidraw>
            {api !== null && <RemoteSelections api={api} peers={selections} />}
            <span ref={probe} hidden />
        </div>
    );
}
