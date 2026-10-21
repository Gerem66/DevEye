import { useCallback, useEffect, useState } from 'react';

import { Button, ErrorNote, errorNote, type ErrorNoteInput } from 'deveye-sdk-client';
import type { UptimeIntegrityReading, UptimeService } from '../contracts/domain';

import { api } from './api';
import DetailDialog, { type Detail } from './DetailDialog';
import { PERIODS } from './format';
import ReadingRow from './ReadingRow';
import styles from './style.module.css';

const PAGE = 100;

interface ReadingsBrowserProps {
    service: UptimeService;
    onBack: () => void;
}

/**
 * Le journal complet des lectures des fichiers, à son propre étage sous la
 * fiche, comme celui des mesures : filtré, et qui défile dans sa boîte.
 */
export function ReadingsBrowser({ service, onBack }: ReadingsBrowserProps) {
    const [periodSeconds, setPeriodSeconds] = useState<number | null>(null);
    const [failuresOnly, setFailuresOnly] = useState(false);
    const [readings, setReadings] = useState<UptimeIntegrityReading[]>([]);
    const [more, setMore] = useState(false);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);

    const id = service.id;

    const buildFilter = useCallback(
        () => ({
            since: periodSeconds === null ? null : Math.floor(Date.now() / 1000) - periodSeconds,
            failuresOnly
        }),
        [periodSeconds, failuresOnly]
    );

    useEffect(() => {
        let cancelled = false;
        setBusy(true);
        setError(null);
        api.send('uptime.integrityReadings', { id, limit: PAGE, filter: buildFilter() })
            .then((page) => {
                if (cancelled) return;
                setReadings(page.readings);
                setMore(page.readings.length === PAGE);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(errorNote(e, 'Chargement des lectures impossible.'));
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [id, buildFilter]);

    async function loadMore(): Promise<void> {
        const before = readings[readings.length - 1]?.at;
        if (before === undefined) return;
        setBusy(true);
        setError(null);
        try {
            const page = await api.send('uptime.integrityReadings', { id, limit: PAGE, before, filter: buildFilter() });
            setReadings((prev) => [...prev, ...page.readings]);
            setMore(page.readings.length === PAGE);
        } catch (e) {
            setError(errorNote(e, 'Chargement des lectures impossible.'));
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
                    <h3 className={styles.detailName}>Journal des intégrités</h3>
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
                    Écarts seulement
                </button>
            </div>

            <ErrorNote note={error} />

            {readings.length === 0 && !busy && error === null ? (
                <p className={styles.empty}>Aucune lecture ne correspond à ces filtres.</p>
            ) : (
                <>
                    <ul className={`${styles.list} ${styles.journal}`}>
                        {readings.map((reading, i) => (
                            <ReadingRow key={`${reading.at}-${i}`} reading={reading} onDetail={setDetail} />
                        ))}
                    </ul>
                    {more && (
                        <Button variant='ghost' disabled={busy} onClick={() => void loadMore()}>
                            Charger plus
                        </Button>
                    )}
                </>
            )}

            <DetailDialog serviceId={id} detail={detail} onClose={() => setDetail(null)} />
        </div>
    );
}

export default ReadingsBrowser;
