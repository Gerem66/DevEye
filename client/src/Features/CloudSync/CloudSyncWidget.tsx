import { useEffect } from 'react';

import { acquireCloudSync, useCloudSyncLive } from '@/stores/cloudSync';
import HeroIcon from './HeroIcon';
import { aggregateState, stateLook } from './state';
import { useShares } from './useShares';
import styles from './style.module.css';

/** Carte compacte de la grille : l'état agrégé de tous les partages. */
export default function CloudSyncWidget() {
    const shares = useShares();
    const { stateFor } = useCloudSyncLive();

    useEffect(() => {
        if (!shares || shares.length === 0) return;
        return acquireCloudSync(shares.map((s) => s.id));
    }, [shares]);

    if (!shares || shares.length === 0) {
        return (
            <div className={styles.widget}>
                <div className={`${styles.widgetBadge} ${styles.widgetMuted}`}>
                    <span className={`icon icon-cloud ${styles.widgetIcon}`} />
                </div>
                <span className={styles.widgetLabel}>{shares === null ? 'Chargement…' : 'À configurer'}</span>
            </div>
        );
    }

    const states = shares.map(
        (s) => stateFor(s.id)?.state ?? (s.status === 'paused' ? ('paused' as const) : ('synced' as const))
    );
    const aggregated = aggregateState(states);
    const look = stateLook(aggregated);

    return (
        <div className={styles.widget}>
            <div className={`${styles.widgetBadge} ${look.badgeClass}`}>
                <HeroIcon key={aggregated} state={aggregated} className={styles.widgetSvg} />
            </div>
            <span className={styles.widgetLabel}>{look.label}</span>
        </div>
    );
}
