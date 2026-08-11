import { useEffect, useState } from 'react';
import type { BaselineEntry, BaselineKind } from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';

import styles from './style.module.css';

/**
 * L'inventaire appris d'une machine : ce que Sentinelle considère comme normal.
 *
 * C'est la page qui rend le détecteur explicable. Sans elle, « nouveau
 * programme » est une affirmation qu'on ne peut ni vérifier ni contredire ; avec
 * elle, on voit exactement ce qui est connu, depuis quand, et sous quel compte.
 *
 * Le bouton de remise à zéro est ici et pas dans les réglages parce que c'est
 * ici qu'on comprend pourquoi on en aurait besoin — typiquement après une montée
 * de version d'agent qui change ce qui est observé (l'arrivée des chemins
 * d'exécutables redéfinit la clé d'un programme).
 */

const KIND_LABEL: Record<BaselineKind, string> = {
    process: 'Programmes',
    listener: 'Ports en écoute',
    persistence: 'Persistance',
    account: 'Comptes'
};

const KINDS: BaselineKind[] = ['process', 'listener', 'persistence'];

interface Props {
    deviceId: string;
    deviceName: string;
    /** Rejouée après une remise à zéro, pour que la vue d'ensemble suive. */
    onChanged: () => void;
}

export default function BaselinePanel({ deviceId, deviceName, onChanged }: Props) {
    const [kind, setKind] = useState<BaselineKind>('process');
    const [entries, setEntries] = useState<BaselineEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [resetting, setResetting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        void (async () => {
            try {
                const res = await ws.send('sentinel.baseline', { deviceId, kind, limit: 500 });
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
    }, [deviceId, kind]);

    async function reset(): Promise<void> {
        setResetting(true);
        try {
            await ws.send('sentinel.resetBaseline', { deviceId });
            setEntries([]);
            setTotal(0);
            onChanged();
        } catch {
            setError('La remise à zéro a échoué.');
        } finally {
            setResetting(false);
        }
    }

    return (
        <div className={styles.baseline}>
            <header className={styles.baselineHead}>
                <div className={styles.tabs}>
                    {KINDS.map((k) => (
                        <button
                            key={k}
                            type='button'
                            className={`${styles.tab} ${k === kind ? styles.tabActive : ''}`}
                            onClick={() => setKind(k)}
                        >
                            {KIND_LABEL[k]}
                        </button>
                    ))}
                </div>
                <Button variant='ghost' icon='refresh' disabled={resetting} onClick={() => void reset()}>
                    Réapprendre
                </Button>
            </header>

            <p className={styles.baselineHint}>
                Réapprendre efface ce qui a été observé sur « {deviceName} » et relance une fenêtre d’apprentissage. Les
                décisions « légitime » sont conservées : ce sont des choix, pas des observations.
            </p>

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
                                <span className={styles.baselineKey}>{entry.key}</span>
                                <span className={styles.baselineMeta}>
                                    {entry.attrs.users.length > 0 && <span>{entry.attrs.users.join(', ')}</span>}
                                    {entry.attrs.listenPorts.length > 0 && (
                                        <span>ports {entry.attrs.listenPorts.join(', ')}</span>
                                    )}
                                    <span>{entry.samples} relevés</span>
                                    {entry.allowed && <span className={styles.findingBadge}>légitime</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
