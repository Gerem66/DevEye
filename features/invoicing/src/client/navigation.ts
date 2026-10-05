import { useEffect } from 'react';

/**
 * Ouvrir un document depuis un panneau de réglages : le brouillon qu'on vient
 * de dupliquer, une pièce des archives. La coquille ne rend la main qu'à la
 * fiche qui l'a ouverte, et c'est la vue de la feature qui tient la navigation.
 */
const openers = new Set<(id: number) => void>();

export function openDocument(id: number): void {
    for (const open of openers) open(id);
}

/** La vue de la feature s'y abonne tant qu'elle est montée. */
export function useDocumentOpener(open: (id: number) => void): void {
    useEffect(() => {
        openers.add(open);
        return () => {
            openers.delete(open);
        };
    }, [open]);
}
