import type { ReactNode } from 'react';

import { openInfo } from '@/Components/InfoPopup';

import { GLOSSARY, type GlossaryTermId } from './glossary';
import styles from './style.module.css';

export type { GlossaryTermId };

export interface TermProps {
    id: GlossaryTermId;
    /** Le terme tel que la phrase l'emploie ; à défaut, le titre de sa définition. */
    children?: ReactNode;
}

/**
 * Un terme technique dans une phrase : il se lit comme le reste du texte, et
 * ouvre sa définition au clic. Ce qui permet à la phrase de rester courte sans
 * laisser le lecteur seul devant le mot.
 */
export default function Term({ id, children }: TermProps) {
    const entry = GLOSSARY[id];

    return (
        <button
            type='button'
            className={styles.term}
            aria-haspopup='dialog'
            title='Voir la définition'
            onClick={() =>
                void openInfo({
                    title: entry.title,
                    body: entry.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
                })
            }
        >
            {children ?? entry.title}
        </button>
    );
}
