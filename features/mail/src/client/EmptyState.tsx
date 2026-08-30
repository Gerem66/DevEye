import { Button } from 'deveye-sdk-client';

import styles from './style.module.css';
import { describeEmptyState, type MailViewState } from './viewState';

/**
 * Ce qu'affiche une colonne qui n'a rien à montrer : ce qui manque, pourquoi, et
 * le geste qui en sort quand il y en a un.
 *
 * Un seul composant pour la colonne des dossiers et celle des messages : les
 * deux se vident des mêmes causes, et deux textes écrits séparément finissaient
 * par se contredire.
 */
export function EmptyState({
    state,
    onAction,
    busy
}: {
    state: MailViewState;
    /** Le recours de l'état, quand il en propose un. */
    onAction?: () => void;
    busy?: boolean;
}) {
    const view = describeEmptyState(state);
    if (!view) return null;

    return (
        <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>{view.title}</p>
            {view.hint && <p className={styles.empty}>{view.hint}</p>}
            {view.action && onAction && (
                <div>
                    <Button variant='secondary' icon='refresh' disabled={busy} onClick={onAction}>
                        {busy ? 'Relève…' : view.action}
                    </Button>
                </div>
            )}
        </div>
    );
}

export default EmptyState;
