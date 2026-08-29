import { useState } from 'react';
import { Button } from 'deveye-sdk-client';
import type { Database, DatabaseAlert, DatabaseProbe, DatabaseUsage } from '../contracts/domain';

import { DatabaseHeader } from './DatabaseHeader';
import { DatabaseView } from './DatabaseView';
import { PROJECT_STATUS_LABELS } from './format';
import styles from './style.module.css';

interface DatabaseDetailProps {
    database: Database;
    usage: DatabaseUsage[];
    alerts: DatabaseAlert[];
    canWrite: boolean;
    busy: boolean;
    testing: boolean;
    probe: DatabaseProbe | null;
    onBack: () => void;
    onEdit: () => void;
    onTest: () => void;
    onInspect: () => void;
    onOpenProject: (projectId: number) => void;
}

/**
 * Une base ouverte dans sa feature. En plein écran, l'en-tête s'efface et la
 * racine prend toute la hauteur de la popup : seul cet écran possède les deux.
 */
export function DatabaseDetail({
    database,
    usage,
    alerts,
    canWrite,
    busy,
    testing,
    probe,
    onBack,
    onEdit,
    onTest,
    onInspect,
    onOpenProject
}: DatabaseDetailProps) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className={expanded ? styles.rootExpanded : styles.root}>
            {!expanded && (
                <DatabaseHeader
                    database={database}
                    canWrite={canWrite}
                    busy={busy}
                    onTest={onTest}
                    onInspect={onInspect}
                    onEdit={onEdit}
                    before={
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Bases
                        </Button>
                    }
                />
            )}

            <DatabaseView
                database={database}
                alerts={alerts}
                canWrite={canWrite}
                testing={testing}
                probe={probe}
                onExpandChange={setExpanded}
            >
                {usage.length > 0 && (
                    <section className={styles.panel}>
                        <h3 className={styles.panelTitle}>
                            {usage.length} projet{usage.length > 1 ? 's' : ''}
                        </h3>
                        <ul className={styles.usageList}>
                            {usage.map((u) => (
                                <li key={u.projectId}>
                                    <button
                                        type='button'
                                        className={styles.usageItem}
                                        onClick={() => onOpenProject(u.projectId)}
                                    >
                                        <span className='icon icon-projects' />
                                        <span>{u.title}</span>
                                        <span className={styles.status} data-status={u.status}>
                                            {PROJECT_STATUS_LABELS[u.status]}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </DatabaseView>
        </div>
    );
}

export default DatabaseDetail;
