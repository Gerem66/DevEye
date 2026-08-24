import { useCallback, useEffect, useState } from 'react';
import { SENTINEL_RULES, type AllowEntry } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';

import styles from './style.module.css';

/**
 * Les décisions prises : « ceci est légitime ici », ou partout.
 *
 * Sans cet écran, acquitter était un aller sans retour. On créait des
 * autorisations en jugeant des constats, et plus rien ne permettait ensuite de
 * savoir lesquelles existaient, qui les avait posées, ni de revenir dessus —
 * une décision d'un jour devenait un angle mort permanent.
 *
 * Retirer une autorisation ne rouvre pas le constat sur-le-champ : c'est le
 * moteur qui le refera au tour suivant, **si la situation existe encore**. Une
 * autorisation retirée pour un programme depuis désinstallé ne ressuscite rien,
 * ce qui est le comportement voulu.
 */

interface Props {
    /** `null` = toutes les autorisations de l'espace (vue de flotte). */
    deviceId: string | null;
    /** Rejouée après un retrait, pour que constats et décomptes suivent. */
    onChanged: () => void;
}

export default function AllowlistSection({ deviceId, onChanged }: Props) {
    const [open, setOpen] = useState(false);
    const [entries, setEntries] = useState<AllowEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await ws.send('sentinel.allowlist', { deviceId });
            setEntries(res.entries);
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
    }, [deviceId]);

    // Se referme en changeant de portée : garder ouvert l'inventaire de la
    // machine précédente ferait lire des décisions qui ne la concernent plus.
    useEffect(() => {
        setOpen(false);
        setEntries([]);
    }, [deviceId]);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    async function remove(entry: AllowEntry): Promise<void> {
        setBusyId(entry.id);
        setError(null);
        try {
            await ws.send('sentinel.removeAllow', { allowId: entry.id });
            setEntries((prev) => prev.filter((e) => e.id !== entry.id));
            onChanged();
        } catch {
            setError("L'autorisation n'a pas pu être retirée.");
        } finally {
            setBusyId(null);
        }
    }

    return (
        <section className={styles.section}>
            <button
                type='button'
                className={styles.sectionToggle}
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
            >
                <span
                    className={`icon icon-chevron ${styles.sectionChevron} ${open ? styles.sectionChevronOpen : ''}`}
                />
                <h3 className={styles.sectionTitle}>Décisions</h3>
                <span className={styles.sectionHint}>
                    {open ? 'ce que vous avez jugé légitime' : 'voir ce que vous avez jugé légitime'}
                </span>
            </button>

            {open && (
                <div className={styles.baseline}>
                    {error && <p className={styles.error}>{error}</p>}

                    {loading ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : entries.length === 0 ? (
                        <p className={styles.empty}>
                            Aucune décision pour l’instant. Marquer un constat « légitime » en crée une, et l’empêche de
                            revenir.
                        </p>
                    ) : (
                        <ul className={styles.allowRows}>
                            {entries.map((entry) => (
                                <li key={entry.id} className={styles.allowRow}>
                                    <span className={styles.allowMain}>
                                        <span className={styles.allowRule}>
                                            {SENTINEL_RULES[entry.rule].label}
                                            <span className={styles.chip}>
                                                {entry.deviceId === null
                                                    ? 'toute la flotte'
                                                    : (entry.deviceName ?? 'cet appareil')}
                                            </span>
                                        </span>
                                        <span className={styles.allowSubject} title={entry.subject}>
                                            {entry.subject}
                                        </span>
                                        {entry.reason && <span className={styles.allowReason}>« {entry.reason} »</span>}
                                    </span>
                                    <Button
                                        variant='ghost'
                                        icon='trash'
                                        disabled={busyId === entry.id}
                                        onClick={() => void remove(entry)}
                                    >
                                        Retirer
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}
