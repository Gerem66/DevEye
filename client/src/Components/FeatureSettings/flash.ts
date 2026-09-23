import type { FeatureId } from '@deveye/types';

/**
 * « C'est ici que ça se règle » : une action prise hors des réglages (une
 * bannière qui remet une page en ligne) montre le bouton qui ouvre ce réglage,
 * pour que l'on apprenne où il vit. Un simple émetteur : le bouton de la
 * portée visée l'écoute, et s'il n'est pas à l'écran, rien ne se passe.
 */

export type FlashScope = { kind: 'feature'; feature: FeatureId } | { kind: 'item'; feature: FeatureId; itemId: string };

type Listener = (key: string) => void;

const listeners = new Set<Listener>();

/** La clé d'un bouton : sa portée, élément compris, pour ne pas éclairer celui d'à côté. */
export function flashKey(scope: FlashScope): string {
    return scope.kind === 'item' ? `item:${scope.feature}:${scope.itemId}` : `feature:${scope.feature}`;
}

export function flashSettings(scope: FlashScope): void {
    const key = flashKey(scope);
    for (const listener of listeners) listener(key);
}

export function onFlash(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
