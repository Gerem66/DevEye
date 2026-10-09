import { useEffect, useState } from 'react';

import { Button } from 'deveye-sdk-client';
import type { UptimeIntegrityOutcome, UptimeIntegrityReading } from '../contracts/domain';

import { api } from './api';
import { formatMs } from '../contracts/format';
import { formatMoment } from './format';
import Pane from './Pane';
import styles from './style.module.css';

/** Lectures chargées d'abord, puis à chaque « Charger plus ». */
const PAGE = 8;

const OUTCOMES: Record<UptimeIntegrityOutcome, { label: string; dot: string }> = {
    learned: { label: 'Référence apprise', dot: styles.dotInfo },
    conform: { label: 'Conforme', dot: styles.dotUp },
    drift: { label: 'Écart', dot: styles.dotDown },
    failed: { label: 'Lecture ratée', dot: styles.dotWarn },
    accepted: { label: 'Acceptée', dot: styles.dotInfo },
    pending: { label: 'En attente d’un déploiement', dot: styles.dotWarn }
};

/** Ce que dit une lecture après son constat : ses fichiers, ou ce qui ne va pas. */
function describe(reading: UptimeIntegrityReading): string {
    if (reading.error !== null) return reading.error;
    const parts: string[] = [];
    if (reading.fileCount !== null) parts.push(`${reading.fileCount} fichier${reading.fileCount > 1 ? 's' : ''}`);
    if (reading.slowestMs !== null) parts.push(`le plus lent en ${formatMs(reading.slowestMs)}`);
    return parts.join(', ');
}

interface IntegrityJournalProps {
    serviceId: number;
    /** `integrityCheckedAt` : il bouge à chaque lecture, ce qui relit le journal. */
    stamp: number | null;
}

/** Chaque lecture des fichiers d'un service, la plus récente en tête. */
export function IntegrityJournal({ serviceId, stamp }: IntegrityJournalProps) {
    const [readings, setReadings] = useState<UptimeIntegrityReading[]>([]);
    const [more, setMore] = useState(false);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setBusy(true);
        setError(null);
        api.send('uptime.integrityReadings', { id: serviceId, limit: PAGE })
            .then((res) => {
                if (cancelled) return;
                setReadings(res.readings);
                setMore(res.readings.length === PAGE);
            })
            .catch(() => {
                if (!cancelled) setError('Journal des intégrités indisponible.');
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [serviceId, stamp]);

    async function loadMore(): Promise<void> {
        const before = readings[readings.length - 1]?.at;
        if (before === undefined) return;
        setBusy(true);
        setError(null);
        try {
            const page = await api.send('uptime.integrityReadings', { id: serviceId, limit: PAGE, before });
            setReadings((prev) => [...prev, ...page.readings]);
            setMore(page.readings.length === PAGE);
        } catch {
            setError('Journal des intégrités indisponible.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className={styles.journalPanel}>
            <h4 className={styles.sectionTitle}>Journal des intégrités</h4>
            {error && <p className={styles.error}>{error}</p>}
            <Pane busy={busy}>
                {readings.length === 0 ? (
                    // Un chargement raté ne se fait pas passer pour un journal vide.
                    error === null && (
                        <p className={styles.empty}>
                            Aucune lecture des fichiers pour l’instant : la prochaine sonde les relira.
                        </p>
                    )
                ) : (
                    <ul className={styles.list}>
                        {readings.map((reading, i) => (
                            <li key={`${reading.at}-${i}`} className={`${styles.checkRow} ${styles.readingRow}`}>
                                <span className={`${styles.dot} ${OUTCOMES[reading.outcome].dot}`} aria-hidden='true' />
                                <span className={styles.checkWhen}>{formatMoment(reading.at)}</span>
                                <span className={styles.readingOutcome}>{OUTCOMES[reading.outcome].label}</span>
                                <span className={styles.readingText}>{describe(reading)}</span>
                                {reading.lines.length > 0 && (
                                    <details className={styles.readingLines}>
                                        <summary>Voir les fichiers</summary>
                                        <ul className={styles.driftLines}>
                                            {reading.lines.map((line, j) => (
                                                <li key={j}>{line}</li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </Pane>
            {more && (
                <Button variant='ghost' disabled={busy} onClick={() => void loadMore()}>
                    Charger plus
                </Button>
            )}
        </section>
    );
}

export default IntegrityJournal;
