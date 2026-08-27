import { useUptimeCount } from './store';

import styles from './style.module.css';

/**
 * Compact dashboard card for Uptime: services confirmed healthy over the total
 * monitored, tinted red as soon as one is down. Backed by the shared count
 * store, so it shows the same figure as the navbar widget from one query.
 */
export function UptimeWidget() {
    const { total, up, down, loading } = useUptimeCount();
    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={`${styles.widgetValue} ${down > 0 ? styles.widgetDown : ''}`}>
                    {loading ? '—' : `${up}/${total}`}
                </span>
                <span className={styles.widgetLabel}>en ligne</span>
            </div>
            <span className={styles.widgetFoot}>
                {loading
                    ? 'Chargement…'
                    : total === 0
                      ? 'Aucun service surveillé'
                      : down > 0
                        ? `${down} service${down > 1 ? 's' : ''} à vérifier`
                        : 'Tout est opérationnel'}
            </span>
        </div>
    );
}

export default UptimeWidget;
