import { useEffect, useState } from 'react';
import type { BaselineEntry, BaselineKind, DeviceSentinelState } from 'deveye-types';

import { ws } from '@/api/ws';

import styles from './style.module.css';

/**
 * L'inventaire appris d'une machine : ce que Sentinelle tient pour normal.
 *
 * C'est ce qui rend le détecteur explicable. Sans lui, « nouveau programme » est
 * une affirmation qu'on ne peut ni vérifier ni contredire ; avec lui, on voit ce
 * qui est connu, depuis quand, sous quel compte.
 *
 * **Repliée par défaut**, et chargée seulement à l'ouverture : c'est cinq cents
 * lignes qu'on ne consulte qu'en cas de doute, et les faire descendre sous les
 * constats à chaque visite noierait ce qu'on est venu voir.
 */

const KIND_LABEL: Record<BaselineKind, string> = {
    process: 'Programmes',
    listener: 'Ports en écoute',
    persistence: 'Persistance',
    account: 'Comptes'
};

const KINDS: BaselineKind[] = ['process', 'listener', 'persistence'];

export default function BaselineSection({ device }: { device: DeviceSentinelState }) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<BaselineKind>('process');
    const [entries, setEntries] = useState<BaselineEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Se referme quand on change de machine : laisser la section ouverte sur
    // l'inventaire de la précédente ferait lire des chiffres qui ne sont plus
    // ceux de la machine affichée.
    useEffect(() => {
        setOpen(false);
        setEntries([]);
        setTotal(0);
    }, [device.deviceId]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        void (async () => {
            try {
                const res = await ws.send('sentinel.baseline', {
                    deviceId: device.deviceId,
                    kind,
                    limit: 500
                });
                if (cancelled) return;
                setEntries(res.entries);
                setTotal(res.total);
                setError(null);
            } catch {
                if (!cancelled) setError('Chargement impossible.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, device.deviceId, kind]);

    return (
        <section className={styles.section}>
            <button
                type='button'
                className={styles.sectionToggle}
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
            >
                <span
                    className={`icon icon-expand ${styles.sectionChevron} ${open ? styles.sectionChevronOpen : ''}`}
                />
                <h3 className={styles.sectionTitle}>Ligne de base</h3>
                <span className={styles.sectionHint}>
                    {open ? 'ce qui est tenu pour normal' : 'voir ce qui est tenu pour normal'}
                </span>
            </button>

            {open && (
                <div className={styles.baseline}>
                    <div className={styles.filters}>
                        {KINDS.map((k) => (
                            <button
                                key={k}
                                type='button'
                                className={`${styles.filter} ${k === kind ? styles.filterActive : ''}`}
                                onClick={() => setKind(k)}
                            >
                                {KIND_LABEL[k]}
                            </button>
                        ))}
                    </div>

                    {error && <p className={styles.error}>{error}</p>}

                    {loading ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : entries.length === 0 ? (
                        <p className={styles.empty}>
                            Rien d’appris pour l’instant. La ligne de base se remplit à chaque relevé.
                        </p>
                    ) : (
                        <>
                            <p className={styles.baselineCount}>
                                {total} entrée{total > 1 ? 's' : ''}
                                {entries.length < total && ` — ${entries.length} affichées`}
                            </p>
                            <ul className={styles.baselineRows}>
                                {entries.map((entry) => (
                                    <li key={entry.key} className={styles.baselineRow}>
                                        <span className={styles.baselineKey} title={entry.key}>
                                            {entry.key}
                                        </span>
                                        <span className={styles.baselineMeta}>
                                            {entry.allowed && <span className={styles.chip}>légitime</span>}
                                            {entry.attrs.users.length > 0 && (
                                                <span>{entry.attrs.users.join(', ')}</span>
                                            )}
                                            {entry.attrs.listenPorts.length > 0 && (
                                                <span>ports {entry.attrs.listenPorts.join(', ')}</span>
                                            )}
                                            <span>{entry.samples} relevés</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
