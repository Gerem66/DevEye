import type { ReactNode } from 'react';
import type { Database } from 'deveye-types';
import { Button } from '@/Components';
import { ENGINE_LABELS, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseHeaderProps {
    database: Database;
    canWrite: boolean;
    busy: boolean;
    onTest: () => void;
    onInspect: () => void;
    onEdit: () => void;
    /** Posé avant l'identité — un retour à la liste, par exemple. */
    before?: ReactNode;
    /** Posé après les boutons — un « Délier », par exemple. */
    after?: ReactNode;
}

/**
 * L'en-tête d'une base : ce qu'elle est, et ce qu'on peut lui faire.
 *
 * Partagé entre la feature et l'onglet d'un projet, comme le contenu qu'il
 * surmonte. Ce qui diffère d'un contexte à l'autre entre par `before` et
 * `after` : la feature met un retour à la liste, l'onglet d'un projet un
 * « Délier » — le reste est identique, et doit le rester.
 */
export function DatabaseHeader({
    database,
    canWrite,
    busy,
    onTest,
    onInspect,
    onEdit,
    before,
    after
}: DatabaseHeaderProps) {
    const status = STATUS_META[database.status];

    return (
        <header className={styles.header}>
            <div className={styles.detailHead}>
                {before}
                <div className={styles.ident}>
                    <p className={styles.cardName}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden='true' />
                        {database.name}
                    </p>
                    <p className={styles.cardMeta}>
                        {ENGINE_LABELS[database.engine]} · {database.host}:{database.port}/{database.database}
                        {database.access.kind !== 'direct' && (
                            <span className={styles.viaTag}>
                                via {database.access.kind === 'ssh' ? 'SSH' : 'SOCKS'} {database.access.host}
                            </span>
                        )}
                    </p>
                    {database.lastError && <p className={styles.error}>{database.lastError}</p>}
                </div>
            </div>
            {canWrite && (
                <div className={styles.actions}>
                    <Button variant='secondary' icon='refresh' onClick={onTest} disabled={busy}>
                        Tester
                    </Button>
                    <Button variant='secondary' icon='search' onClick={onInspect} disabled={busy}>
                        Relever
                    </Button>
                    <Button variant='secondary' icon='edit' onClick={onEdit} disabled={busy}>
                        Modifier
                    </Button>
                    {after}
                </div>
            )}
        </header>
    );
}

export default DatabaseHeader;
