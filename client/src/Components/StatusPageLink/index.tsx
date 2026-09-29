import type { ReactNode } from 'react';

import { useStatusPageHref } from '@/stores/statusPage';

import styles from './style.module.css';

interface Props {
    /** La page de cette fonctionnalité plutôt que la vue d'ensemble. */
    featureId?: string | null;
    children: ReactNode;
}

/** Un lien vers la page d'état publique, dans un nouvel onglet ; rien sans page configurée. */
export default function StatusPageLink({ featureId, children }: Props) {
    const href = useStatusPageHref(featureId);
    if (href === null) return null;
    return (
        <a className={styles.link} href={href} target='_blank' rel='noopener noreferrer'>
            <span className='icon icon-activity' aria-hidden='true' />
            {children}
        </a>
    );
}
