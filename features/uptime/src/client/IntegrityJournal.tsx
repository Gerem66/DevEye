import { useEffect, useState } from 'react';

import { Button, ErrorNote, errorNote, type ErrorNoteInput } from 'deveye-sdk-client';
import type { UptimeIntegrityReading } from '../contracts/domain';

import { api } from './api';
import DetailDialog, { type Detail } from './DetailDialog';
import Pane from './Pane';
import ReadingRow from './ReadingRow';
import styles from './style.module.css';

/** Lectures montrées dans la fiche ; le journal complet vit dans {@link ReadingsBrowser}. */
const READINGS_PREVIEW = 8;

interface IntegrityJournalProps {
    serviceId: number;
    /** `integrityCheckedAt` : il bouge à chaque lecture, ce qui relit le journal. */
    stamp: number | null;
    onOpenAll: () => void;
}

/** Les dernières lectures des fichiers d'un service, la plus récente en tête. */
export function IntegrityJournal({ serviceId, stamp, onOpenAll }: IntegrityJournalProps) {
    const [readings, setReadings] = useState<UptimeIntegrityReading[]>([]);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);

    useEffect(() => {
        let cancelled = false;
        setBusy(true);
        setError(null);
        api.send('uptime.integrityReadings', {
            id: serviceId,
            limit: READINGS_PREVIEW,
            filter: { since: null, failuresOnly: false }
        })
            .then((res) => {
                if (!cancelled) setReadings(res.readings);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(errorNote(e, 'Journal des intégrités indisponible.'));
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [serviceId, stamp]);

    return (
        <section className={styles.journalPanel}>
            <h4 className={styles.sectionTitle}>Journal des intégrités</h4>
            <ErrorNote note={error} />
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
                            <ReadingRow key={`${reading.at}-${i}`} reading={reading} onDetail={setDetail} />
                        ))}
                    </ul>
                )}
            </Pane>
            <Button variant='ghost' icon='list' onClick={onOpenAll}>
                Voir toutes les lectures
            </Button>
            <DetailDialog serviceId={serviceId} detail={detail} onClose={() => setDetail(null)} />
        </section>
    );
}

export default IntegrityJournal;
