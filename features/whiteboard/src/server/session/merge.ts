import { TOMBSTONE_TTL_MS, type SceneElement } from '../../contracts/domain';

/**
 * La règle d'Excalidraw (`shouldDiscardRemoteElement`) : la version la plus
 * haute gagne ; à version égale, le `versionNonce` le plus bas. Deux éléments
 * identiques en version et en nonce sont le même : rien ne change.
 */
export function wins(incoming: SceneElement, current: SceneElement | undefined): boolean {
    if (current === undefined) return true;
    if (incoming.version !== current.version) return incoming.version > current.version;
    return incoming.versionNonce < current.versionNonce;
}

/**
 * L'ordre d'affichage : l'indice fractionnaire, comparé comme une chaîne. Un
 * élément sans indice (à réparer par le client) passe après, dans l'ordre
 * d'arrivée.
 */
export function ordered(elements: Iterable<SceneElement>): SceneElement[] {
    const list = [...elements];
    const rank = new Map(list.map((el, i) => [el, i]));
    return list.sort((a, b) => {
        const ia = a.index ?? null;
        const ib = b.index ?? null;
        if (ia !== null && ib !== null && ia !== ib) return ia < ib ? -1 : 1;
        if (ia === null && ib !== null) return 1;
        if (ia !== null && ib === null) return -1;
        return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    });
}

/** Retire les éléments supprimés depuis plus d'un jour ; rend les octets libérés. */
export function pruneTombstones(
    elements: Map<string, SceneElement>,
    sizes: Map<string, number>,
    nowMs: number
): number {
    let freed = 0;
    for (const [id, el] of elements) {
        if (el.isDeleted && nowMs - el.updated > TOMBSTONE_TTL_MS) {
            elements.delete(id);
            freed += sizes.get(id) ?? 0;
            sizes.delete(id);
        }
    }
    return freed;
}

/** La taille d'un élément dans le JSON de la scène, à la virgule près. */
export function sizeOf(el: SceneElement): number {
    return Buffer.byteLength(JSON.stringify(el), 'utf8') + 1;
}
