import type { ReactNode } from 'react';

import styles from './FeatureSettings.module.css';

/**
 * Le refus d'un droit dans un panneau de réglages, d'une seule silhouette pour
 * toutes les fonctionnalités : sans composant commun, chaque panneau
 * réinventait sa taille et sa couleur, et deux onglets voisins ne se
 * ressemblaient plus.
 *
 * Le cadenas est le glyphe des motifs de droit (voir `Docs/PERMISSIONS.md`) :
 * ce qui bloque autrement, un appareil archivé ou un élément non projetable,
 * n'est pas de ce ressort et garde sa propre phrase.
 */
export default function ReadOnlyNotice({ children }: { children: ReactNode }) {
    return (
        <p className={styles.readOnlyNotice}>
            <span className={`icon icon-lock ${styles.readOnlyNoticeIcon}`} aria-hidden='true' />
            <span>{children}</span>
        </p>
    );
}
