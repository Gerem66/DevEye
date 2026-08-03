import { useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import styles from './style.module.css';

/**
 * Compact dashboard card: number of configured mail accounts. Backed by
 * `mail.accountCount`, clear metadata with no unlock gate — same "always
 * renders a number" discipline as `password.count`/`note.count`, just not
 * workspace-scoped (Mail accounts are personal-only in V1).
 */
export function MailWidget() {
    const version = useResourceVersion('mail.accountCount');
    const [count, setCount] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            ws.send('mail.accountCount', {})
                .then((res) => {
                    if (!cancelled) setCount(res.count);
                })
                .catch(() => {});
        };
        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [version]);

    const loading = count === null;
    const plural = loading || count !== 1;

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={styles.widgetValue}>{loading ? '—' : count}</span>
                <span className={styles.widgetLabel}>compte{plural ? 's' : ''}</span>
            </div>
            <span className={styles.widgetFoot}>
                {loading ? 'Chargement…' : count === 0 ? 'Aucune boîte configurée' : 'Boîtes mail configurées'}
            </span>
        </div>
    );
}

export default MailWidget;
