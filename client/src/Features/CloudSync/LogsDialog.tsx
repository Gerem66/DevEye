import { useCallback, useEffect, useState } from 'react';
import type { CloudSyncEvent, CloudSyncShare } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog } from '@/Components';
import styles from './style.module.css';

interface LogsDialogProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    /** Une exclusion vient d'être posée : la vue parente doit se rafraîchir. */
    onChanged: () => void;
}

const PAGE = 50;

/** Le journal d'un partage : chaque anomalie datée, avec fichier et appareil. */
export default function LogsDialog({ open, share, onClose, onChanged }: LogsDialogProps) {
    const [events, setEvents] = useState<CloudSyncEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(
        async (nextOffset: number) => {
            try {
                const out = await ws.send('cloudSync.listEvents', {
                    shareId: share.id,
                    limit: PAGE,
                    offset: nextOffset
                });
                setEvents(out.events);
                setTotal(out.total);
                setOffset(nextOffset);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Chargement impossible.');
            }
        },
        [share.id]
    );

    useEffect(() => {
        if (open) void load(0);
    }, [open, load]);

    /**
     * Sortie de secours des impasses. Une collision de casse (`Foo.txt` et
     * `foo.txt` coexistent sur Linux mais sont LE MÊME fichier sous Windows et
     * macOS) écarte les deux chemins, et rien ne se débloque tout seul. Exclure
     * l'un d'eux résout le conflit et laisse l'autre repartir.
     */
    async function exclude(relPath: string) {
        try {
            await ws.send('cloudSync.addExclusion', { shareId: share.id, kind: 'path', pattern: relPath });
            onChanged();
            await load(offset);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Exclusion impossible.');
        }
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Logs — ${share.name}`}
            description={total === 0 ? 'Aucune anomalie enregistrée.' : `${total} événement(s)`}
            width={640}
            fill
        >
            <div className={styles.browserCol}>
                <div className={`${styles.rows} ${styles.scrollRows}`}>
                    {events.map((ev) => (
                        <div key={ev.id} className={styles.row}>
                            <span className={`icon icon-x-circle ${styles.logIcon}`} />
                            <div className={styles.rowMain}>
                                <span className={styles.rowTitle}>{ev.message}</span>
                                <span className={styles.rowSub}>
                                    {new Date(ev.created * 1000).toLocaleString('fr-FR')}
                                    {ev.deviceName ? ` · ${ev.deviceName}` : ''}
                                    {ev.relPath ? ` · ${ev.relPath}` : ''}
                                </span>
                            </div>
                            {ev.relPath !== null && (
                                <Button
                                    variant='ghost'
                                    title='Ne plus synchroniser ce chemin'
                                    onClick={() => void exclude(ev.relPath as string)}
                                >
                                    Exclure
                                </Button>
                            )}
                        </div>
                    ))}
                    {events.length === 0 && (
                        <div className={styles.mutedNote}>
                            Rien à signaler — les erreurs de synchronisation apparaîtront ici.
                        </div>
                    )}
                </div>
                {total > PAGE && (
                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            disabled={offset === 0}
                            onClick={() => void load(Math.max(0, offset - PAGE))}
                        >
                            Précédent
                        </Button>
                        <span className={styles.mutedNote}>
                            {offset + 1}–{Math.min(offset + PAGE, total)} sur {total}
                        </span>
                        <Button
                            variant='secondary'
                            disabled={offset + PAGE >= total}
                            onClick={() => void load(offset + PAGE)}
                        >
                            Suivant
                        </Button>
                    </div>
                )}
                {error && <div className={styles.mutedNote}>{error}</div>}
            </div>
        </Dialog>
    );
}
