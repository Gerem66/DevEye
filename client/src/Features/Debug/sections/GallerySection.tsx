import { useState } from 'react';

import Button from '@/Components/Button';
import GalleryDialog from '../Gallery/GalleryDialog';
import styles from '../Debug.module.css';

/** La galerie des composants : ouverte dans une grande fenêtre. */
export default function GallerySection() {
    const [open, setOpen] = useState(false);
    return (
        <section className={styles.section}>
            <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>Composants de l’interface</span>
                <Button icon='appearance' onClick={() => setOpen(true)}>
                    Ouvrir la galerie
                </Button>
            </div>
            <p className={styles.sectionHint}>
                Tous les composants que les écrans emploient, en vrai et manipulables : les jetons du thème, les icônes,
                les boutons, la saisie, les retours, les fenêtres et la mise en page. De quoi juger de leur cohérence
                d’un coup d’œil, dans chaque mode de rendu et désactivés.
            </p>
            <GalleryDialog open={open} onClose={() => setOpen(false)} />
        </section>
    );
}
