import { createContext, useContext, type ReactNode } from 'react';

import styles from './Gallery.module.css';

/** « Tout désactiver » de la barre d'outils : chaque démonstration le lit. */
export const GalleryDisabled = createContext(false);

export function useGalleryDisabled(): boolean {
    return useContext(GalleryDisabled);
}

/** Un composant et ses variantes, rangée par rangée. */
export function Specimen({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    return (
        <section className={styles.specimen}>
            <div className={styles.specimenHead}>
                <h4 className={styles.specimenTitle}>{title}</h4>
                {note && <p className={styles.specimenNote}>{note}</p>}
            </div>
            <div className={styles.variants}>{children}</div>
        </section>
    );
}

export function Variant({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
    return (
        <div className={`${styles.variant} ${wide ? styles.variantWide : ''}`}>
            <span className={styles.variantLabel}>{label}</span>
            <div className={styles.variantBody}>{children}</div>
        </div>
    );
}
