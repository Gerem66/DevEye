import type { ReactNode } from 'react';

import styles from './style.module.css';

interface SectionCardProps {
    title: string;
    /** Ce que la carte dit en un coup d'œil : deux ou trois chiffres, pas plus. */
    figures: { value: string; label: string }[];
    /** La phrase qui remplace les chiffres quand il n'y a rien à montrer. */
    empty?: string;
    /** Un visuel discret sous les chiffres (une courbe, une barre). */
    children?: ReactNode;
    onOpen: () => void;
}

/**
 * Une des trois entrées du sommaire d'un site. Un bouton et non un bloc
 * cliquable : c'est ce qui la rend atteignable au clavier et annonçable, sans
 * rôle ni gestionnaire de touches à réécrire.
 */
export function SectionCard({ title, figures, empty, children, onOpen }: SectionCardProps) {
    return (
        <button type='button' className={styles.sectionCard} onClick={onOpen}>
            <span className={styles.sectionHead}>
                <span className={styles.sectionTitle}>{title}</span>
                {/* `icon-chevron` pointe à droite sans rotation : c'est le dépliant
                    de l'installation qui le fait pivoter, pas l'inverse. */}
                <span className={`icon icon-chevron ${styles.sectionChevron}`} aria-hidden='true' />
            </span>

            {empty ? (
                <span className={styles.sectionEmpty}>{empty}</span>
            ) : (
                <span className={styles.sectionFigures}>
                    {figures.map((figure) => (
                        <span key={figure.label} className={styles.sectionFigure}>
                            <span className={styles.sectionValue}>{figure.value}</span>
                            <span className={styles.sectionLabel}>{figure.label}</span>
                        </span>
                    ))}
                </span>
            )}

            {children}
        </button>
    );
}

export default SectionCard;
