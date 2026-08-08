import type { Database, DatabaseAlert, DatabaseProbe, DatabaseUsage } from 'deveye-types';
import { Button } from '@/Components';
import { STATUS_LABELS } from '../Projects/api';
import { DatabaseHeader } from './DatabaseHeader';
import { DatabaseView } from './DatabaseView';
import styles from './style.module.css';

interface DatabaseDetailProps {
    database: Database;
    usage: DatabaseUsage[];
    alerts: DatabaseAlert[];
    canWrite: boolean;
    busy: boolean;
    /** Le dernier essai de connexion, s'il y en a eu un dans cette vue. */
    probe: DatabaseProbe | null;
    onBack: () => void;
    onEdit: () => void;
    onTest: () => void;
    onInspect: () => void;
    onAlertsChanged: () => void;
    onRemoveAlert: (alertId: number) => void;
    onOpenProject: (projectId: number) => void;
}

/**
 * Une base ouverte dans sa feature : le retour à la liste, son en-tête, son
 * contenu, et les projets qui s'en servent.
 *
 * Le contenu est `DatabaseView`, partagé mot pour mot avec l'onglet « Bases de
 * données » d'un projet — c'est la même base, il n'y a aucune raison qu'elle se
 * présente autrement selon la porte par laquelle on entre.
 */
export function DatabaseDetail({
    database,
    usage,
    alerts,
    canWrite,
    busy,
    probe,
    onBack,
    onEdit,
    onTest,
    onInspect,
    onAlertsChanged,
    onRemoveAlert,
    onOpenProject
}: DatabaseDetailProps) {
    return (
        <div className={styles.root}>
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

            <DatabaseView
                database={database}
                alerts={alerts}
                canWrite={canWrite}
                probe={probe}
                onAlertsChanged={onAlertsChanged}
                onRemoveAlert={onRemoveAlert}
            >
                {/*
                 * Les projets qui s'en servent — le second sens de
                 * l'interconnexion. Masqué quand il n'y en a aucun : un panneau
                 * vide n'apprend rien.
                 */}
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
                                            {STATUS_LABELS[u.status]}
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
