import { useCallback, useEffect, useState } from 'react';

import { Button } from 'deveye-sdk-client';
import type { UptimeCheck, UptimeCheckStats, UptimeService } from '../contracts/domain';

import { api } from './api';
import { formatMoment, formatMs } from './format';
import Pane from './Pane';
import styles from './style.module.css';

/** Measures loaded per page. */
const PAGE = 100;

const DAY = 86400;

/** Period filters, as an offset from now (`null` = the whole history). */
const PERIODS: { label: string; seconds: number | null }[] = [
    { label: 'Tout', seconds: null },
    { label: '24 h', seconds: DAY },
    { label: '7 j', seconds: 7 * DAY },
    { label: '30 j', seconds: 30 * DAY }
];

const EMPTY_STATS: UptimeCheckStats = {
    count: 0,
    failures: 0,
    avgMs: null,
    minMs: null,
    maxMs: null,
    firstAt: null,
    lastAt: null
};

interface MeasuresBrowserProps {
    service: UptimeService;
    onBack: () => void;
}

/**
 * The full ping journal, on its own floor below the service detail.
 *
 * It lives here rather than in the detail view because a year of probes is tens
 * of thousands of rows: inline, it would bury the charts and turn the panel into
 * one endless scroll. The detail keeps a short preview and sends you here when
 * you actually want the record: filtered, counted, and scrolling in its own box
 * so the surrounding page never grows.
 */
export function MeasuresBrowser({ service, onBack }: MeasuresBrowserProps) {
    const [periodSeconds, setPeriodSeconds] = useState<number | null>(null);
    const [failuresOnly, setFailuresOnly] = useState(false);
    const [checks, setChecks] = useState<UptimeCheck[]>([]);
    const [stats, setStats] = useState<UptimeCheckStats>(EMPTY_STATS);
    const [more, setMore] = useState(false);
    const [busy, setBusy] = useState(true);
    // Same rule as the detail view: a failed load says so instead of rendering
    // an empty journal, which would read as "this service has no measures".
    const [error, setError] = useState<string | null>(null);

    const id = service.id;

    /** The filter both the page and the aggregates are computed on. */
    const buildFilter = useCallback(
        () => ({
            since: periodSeconds === null ? null : Math.floor(Date.now() / 1000) - periodSeconds,
            failuresOnly
        }),
        [periodSeconds, failuresOnly]
    );

    useEffect(() => {
        let cancelled = false;
        const filter = buildFilter();
        setBusy(true);
        setError(null);
        Promise.all([
            api.send('uptime.checks', { id, limit: PAGE, filter }),
            api.send('uptime.checkStats', { id, filter })
        ])
            .then(([page, aggregate]) => {
                if (cancelled) return;
                setChecks(page.checks);
                setMore(page.checks.length === PAGE);
                setStats(aggregate.stats);
            })
            .catch(() => {
                if (!cancelled) setError('Chargement des mesures impossible.');
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [id, buildFilter]);

    /** Append the next page. The aggregates already cover the whole selection. */
    async function loadMore(): Promise<void> {
        const before = checks[checks.length - 1]?.at;
        if (before === undefined) return;
        setBusy(true);
        setError(null);
        try {
            const page = await api.send('uptime.checks', { id, limit: PAGE, before, filter: buildFilter() });
            setChecks((prev) => [...prev, ...page.checks]);
            setMore(page.checks.length === PAGE);
        } catch {
            setError('Chargement des mesures impossible.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.browser}>
            <div className={styles.detailHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    {service.name}
                </Button>
                <div className={styles.detailTitle}>
                    <h3 className={styles.detailName}>Journal des mesures</h3>
                </div>
            </div>

            <div className={styles.ranges}>
                {PERIODS.map((period) => (
                    <button
                        key={period.label}
                        type='button'
                        className={`${styles.rangeBtn} ${periodSeconds === period.seconds ? styles.rangeActive : ''}`}
                        onClick={() => setPeriodSeconds(period.seconds)}
                    >
                        {period.label}
                    </button>
                ))}
                <button
                    type='button'
                    className={`${styles.rangeBtn} ${failuresOnly ? styles.rangeActive : ''}`}
                    onClick={() => setFailuresOnly((v) => !v)}
                >
                    Échecs seulement
                </button>
            </div>

            {error && <p className={styles.error}>{error}</p>}

            <Pane busy={busy}>
                <div className={styles.summary}>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{stats.count.toLocaleString('fr-FR')}</span>
                        <span className={styles.summaryLabel}>mesures</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{stats.failures.toLocaleString('fr-FR')}</span>
                        <span className={styles.summaryLabel}>échecs</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(stats.avgMs)}</span>
                        <span className={styles.summaryLabel}>latence moyenne</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(stats.minMs)}</span>
                        <span className={styles.summaryLabel}>minimum</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(stats.maxMs)}</span>
                        <span className={styles.summaryLabel}>maximum</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>
                            {stats.firstAt === null ? '—' : formatMoment(stats.firstAt)}
                        </span>
                        <span className={styles.summaryLabel}>première mesure</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>
                            {stats.lastAt === null ? '—' : formatMoment(stats.lastAt)}
                        </span>
                        <span className={styles.summaryLabel}>dernière mesure</span>
                    </div>
                </div>
            </Pane>

            {checks.length === 0 && !busy && error === null ? (
                <p className={styles.empty}>Aucune mesure ne correspond à ces filtres.</p>
            ) : (
                <>
                    {/* Scrolls in its own box: paging through thousands of rows must
                        never stretch the surrounding panel. */}
                    <ul className={`${styles.list} ${styles.journal}`}>
                        {checks.map((check, i) => (
                            <li key={`${check.at}-${i}`} className={styles.checkRow}>
                                <span
                                    className={`${styles.dot} ${check.up ? styles.dotUp : styles.dotDown}`}
                                    aria-hidden='true'
                                />
                                <span className={styles.checkWhen}>{formatMoment(check.at)}</span>
                                <span className={styles.checkStatus}>{check.httpStatus ?? '—'}</span>
                                <span className={styles.checkMs}>{formatMs(check.responseMs)}</span>
                                <span className={styles.checkError}>{check.error ?? ''}</span>
                            </li>
                        ))}
                    </ul>
                    {more && (
                        <Button variant='ghost' disabled={busy} onClick={() => void loadMore().catch(() => {})}>
                            Charger plus
                        </Button>
                    )}
                </>
            )}
        </div>
    );
}

export default MeasuresBrowser;
