import { getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { UserColor } from '@deveye/types';
import { userColorVar } from 'deveye-sdk-client';
import { useEffect, useReducer } from 'react';

export interface PeerSelection {
    clientId: string;
    color: UserColor;
    selectedIds: readonly string[];
}

/** La marge du cadre autour de l'élément, en pixels d'écran. */
const PADDING = 4;

/**
 * Ce que les autres ont sélectionné, entouré de la couleur de leur compte, celle
 * de leur curseur : Excalidraw tirerait la sienne de leur identifiant d'onglet.
 */
export function RemoteSelections({ api, peers }: { api: ExcalidrawImperativeAPI; peers: readonly PeerSelection[] }) {
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    const active = peers.length > 0;
    // Un déplacement, un zoom ou un élément qui bouge : les cadres suivent.
    useEffect(() => (active ? api.onChange(redraw) : undefined), [api, active]);
    if (!active) return null;

    const { scrollX, scrollY, zoom } = api.getAppState();
    const elements = new Map(api.getSceneElements().map((el) => [el.id, el]));
    return (
        <svg className='whiteboard-selections' aria-hidden>
            {peers.flatMap((peer) =>
                peer.selectedIds.flatMap((id) => {
                    const element = elements.get(id);
                    if (!element) return [];
                    const [x1, y1, x2, y2] = getCommonBounds([element]);
                    return [
                        <rect
                            key={`${peer.clientId}:${id}`}
                            x={(x1 + scrollX) * zoom.value - PADDING}
                            y={(y1 + scrollY) * zoom.value - PADDING}
                            width={(x2 - x1) * zoom.value + 2 * PADDING}
                            height={(y2 - y1) * zoom.value + 2 * PADDING}
                            style={{ stroke: userColorVar(peer.color) }}
                        />
                    ];
                })
            )}
        </svg>
    );
}
