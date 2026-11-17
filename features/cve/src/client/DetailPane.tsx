import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import styles from './style.module.css';

/**
 * Une seule constante : la largeur qu'anime framer-motion et celle que le
 * contenu garde pendant qu'elle change. Elle comprend l'écart d'avec la liste
 * (`padding-left` de `.detailInner`), qui vit dans le panneau pour disparaître
 * avec lui plutôt que d'un coup à son démontage.
 */
const DETAIL_WIDTH = 396;

/**
 * Le panneau de droite d'une liste : il n'occupe la place que lorsqu'on veut un
 * détail. `width` : plus large pour un tableau, celui des versions d'un logiciel.
 */
export default function DetailPane({
    open,
    width = DETAIL_WIDTH,
    children
}: {
    open: boolean;
    width?: number;
    children: ReactNode;
}) {
    return (
        <AnimatePresence>
            {open && (
                <motion.aside
                    key='detail'
                    className={styles.detailPane}
                    initial={{ x: 24, width: 0, opacity: 0 }}
                    animate={{ x: 0, width, opacity: 1 }}
                    exit={{ x: 24, width: 0, opacity: 0 }}
                    transition={{
                        type: 'spring',
                        stiffness: 380,
                        damping: 34,
                        opacity: { type: 'tween', duration: 0.12, ease: 'easeOut' }
                    }}
                >
                    {/* Le contenu garde sa largeur pendant que le panneau perd
                        la sienne : `overflow: hidden` le rogne au lieu de le
                        remettre en page. */}
                    <div className={styles.detailInner} style={{ width }}>
                        {children}
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
    );
}
