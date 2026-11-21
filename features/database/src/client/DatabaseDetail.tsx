import { Button, NotificationsNotice, StickyHeader, useLiveOutlines } from 'deveye-sdk-client';
import type { Database, DatabaseAlert, DatabaseKpi, DatabaseUsage } from '../contracts/domain';

import { DatabaseHeader } from './DatabaseHeader';
import { DatabaseOverview } from './DatabaseOverview';
import { TableExplorer } from './TableExplorer';
import { PROJECT_STATUS_LABELS } from '@deveye/types';
import styles from './style.module.css';

export type DatabaseTab = 'overview' | 'tables';

const TABS: { id: DatabaseTab; label: string; icon: string }[] = [
    { id: 'overview', label: 'Vue d’ensemble', icon: 'activity' },
    { id: 'tables', label: 'Tables', icon: 'list' }
];

interface DatabaseDetailProps {
    database: Database;
    usage: DatabaseUsage[];
    alerts: DatabaseAlert[];
    kpis: DatabaseKpi[];
    canWrite: boolean;
    /** L'onglet affiché ; l'appelant le tient, pour qu'il vaille d'une base à l'autre. */
    tab: DatabaseTab;
    onTab: (tab: DatabaseTab) => void;
    onBack: () => void;
    onOpenProject: (projectId: number) => void;
}

/**
 * Une base ouverte dans sa feature, en deux onglets : son état, et ses tables.
 * Sous « Tables », la fiche tient dans la hauteur de la popup : seuls le
 * tableau et la liste défilent.
 */
export function DatabaseDetail({
    database,
    usage,
    alerts,
    kpis,
    canWrite,
    tab,
    onTab,
    onBack,
    onOpenProject
}: DatabaseDetailProps) {
    const outlineOf = useLiveOutlines('l2');

    return (
        <div className={tab === 'tables' ? styles.rootFill : styles.root}>
            <StickyHeader className={styles.sheetSticky}>
                <DatabaseHeader
                    database={database}
                    onGone={onBack}
                    before={
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Bases
                        </Button>
                    }
                />
                <nav className={styles.tabs} role='tablist' aria-label='Sections de la base'>
                    {TABS.map((entry) => (
                        <button
                            key={entry.id}
                            type='button'
                            role='tab'
                            aria-selected={entry.id === tab}
                            className={entry.id === tab ? styles.tabActive : styles.tab}
                            onClick={() => onTab(entry.id)}
                            {...outlineOf(entry.id)}
                        >
                            <span className={`icon icon-${entry.icon} ${styles.tabIcon}`} aria-hidden='true' />
                            <span>{entry.label}</span>
                            {/* Les alertes vivent sous cet onglet : une alerte franchie se voit depuis l'autre. */}
                            {entry.id === 'overview' && database.firingCount > 0 && (
                                <span className={styles.alertTag}>
                                    {database.firingCount} franchie{database.firingCount > 1 ? 's' : ''}
                                </span>
                            )}
                        </button>
                    ))}
                </nav>
            </StickyHeader>

            {tab === 'overview' && (
                <>
                    {/* Une base sans alerte n'a rien à envoyer. */}
                    {alerts.some((a) => a.enabled) && (
                        <NotificationsNotice
                            scope={{
                                kind: 'item',
                                feature: 'database',
                                itemId: String(database.id),
                                itemLabel: database.name
                            }}
                        />
                    )}

                    <DatabaseOverview
                        database={database}
                        alerts={alerts}
                        kpis={kpis}
                        canWrite={canWrite}
                        onOpenTables={() => onTab('tables')}
                    />

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
                </>
            )}

            <TableExplorer database={database} canWrite={canWrite} fill hidden={tab !== 'tables'} />
        </div>
    );
}

export default DatabaseDetail;
