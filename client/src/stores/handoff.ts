import { useEffect } from 'react';

/**
 * Un fichier qu'une fonctionnalité confie à une autre : le PDF assemblé dans
 * l'atelier qui part se faire alléger par le Convertisseur, le PDF déposé dans
 * le Convertisseur qu'on veut signer. Le colis attend en mémoire que la vue
 * destinataire le ramasse ; une seule fois, et jamais au-delà de la page.
 */

export interface HandedFile {
    file: File;
    /** Ce que la destinataire doit en faire, dans ses propres termes (une cible, un onglet). */
    purpose: string | null;
}

const parcels = new Map<string, HandedFile>();
const listeners = new Map<string, Set<(parcel: HandedFile) => void>>();

export function putHandedFile(feature: string, parcel: HandedFile): void {
    parcels.set(feature, parcel);
    for (const listener of listeners.get(feature) ?? []) listener(parcel);
}

/** Le colis laissé à cette fonctionnalité, retiré en le prenant ; `null` sans colis. */
export function takeHandedFile(feature: string): HandedFile | null {
    const parcel = parcels.get(feature) ?? null;
    parcels.delete(feature);
    return parcel;
}

/**
 * Ramasse le colis adressé à `feature` : celui qui attendait au montage, et
 * ceux qui arrivent pendant que la vue est ouverte.
 */
export function useHandedFile(feature: string, onFile: (parcel: HandedFile) => void): void {
    useEffect(() => {
        const waiting = takeHandedFile(feature);
        if (waiting) onFile(waiting);
        const listener = (parcel: HandedFile) => {
            // Pris par celui qui écoute : le colis ne doit pas attendre un second montage.
            parcels.delete(feature);
            onFile(parcel);
        };
        const set = listeners.get(feature) ?? new Set();
        set.add(listener);
        listeners.set(feature, set);
        return () => {
            set.delete(listener);
        };
        // `onFile` est ce que la vue fait du fichier, stable par construction : pas une dépendance.
    }, [feature]);
}
