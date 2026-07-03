import { useState } from 'react';
import type { CloudSyncShare } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button } from '@/Components';
import { formatBytesFr } from '@/Features/Monitoring/utils';
import { useCloudSyncLive } from '@/stores/cloudSync';
import DevicesDialog from './DevicesDialog';
import ExclusionsDialog from './ExclusionsDialog';
import HeroIcon from './HeroIcon';
import LogsDialog from './LogsDialog';
import SettingsDialog from './SettingsDialog';
import VersionsBrowser from './VersionsBrowser';
import { stateLook } from './state';
import styles from './style.module.css';

interface ShareCardProps {
    share: CloudSyncShare;
    onChanged: () => void;
}

/**
 * La carte d'un partage : le héros d'état (gros badge « Synchronisé » vert,
 * ou synchro en cours avec barre de progression et fichier courant), puis une
 * rangée d'actions discrètes.
 */
export default function ShareCard({ share, onChanged }: ShareCardProps) {
    const { stateFor, progressFor } = useCloudSyncLive();
    const [dialog, setDialog] = useState<'devices' | 'exclusions' | 'versions' | 'logs' | 'settings' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const live = stateFor(share.id);
    const shareState = live?.state ?? (share.status === 'paused' ? 'paused' : 'synced');
    const detail = live?.detail ?? null;
    // Volumétrie live (poussée avec chaque événement d'état) ; fallback fetch.
    const stats = live?.stats ?? share.stats;
    const look = stateLook(shareState);

    const sessions = progressFor(share.id);
    const bytesTotal = sessions.reduce((sum, p) => sum + p.bytesTotal, 0);
    const bytesDone = sessions.reduce((sum, p) => sum + p.bytesDone, 0);
    const current = sessions.find((p) => p.currentPath !== null);
    const currentDevice = current ? share.devices.find((d) => d.deviceId === current.deviceId)?.deviceName : null;

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Action impossible.');
        }
    };

    const paused = share.status === 'paused';

    return (
        <section className={styles.card}>
            <header className={styles.cardHeader}>
                <span className={styles.cardTitle}>
                    <span className='icon icon-cloud' />
                    {share.name}
                </span>
                <span className={styles.cardStats}>
                    {stats.fileCount} fichier(s) · {formatBytesFr(stats.liveBytes)}
                </span>
            </header>

            <div className={styles.hero}>
                {/* Le logo EST le bouton pause/reprise : au survol, l'état
                    s'estompe et l'action apparaît en son centre. */}
                <button
                    type='button'
                    className={`${styles.heroBadge} ${look.badgeClass}`}
                    title={paused ? 'Reprendre la synchronisation' : 'Mettre en pause'}
                    onClick={() =>
                        void run(() =>
                            ws.send(paused ? 'cloudSync.resumeShare' : 'cloudSync.pauseShare', {
                                shareId: share.id
                            })
                        )
                    }
                >
                    <HeroIcon key={shareState} state={shareState} className={styles.heroSvg} />
                    <span className={`icon icon-${paused ? 'play-thin' : 'pause-thin'} ${styles.heroHoverIcon}`} />
                </button>
                <div className={styles.heroLabel}>{look.label}</div>
                <div className={styles.heroMeta}>
                    {shareState === 'syncing' ? (
                        <div className={styles.progress}>
                            <span className={styles.bar}>
                                <span
                                    className={styles.barFill}
                                    style={{
                                        width: `${bytesTotal > 0 ? Math.round((bytesDone / bytesTotal) * 100) : 0}%`
                                    }}
                                />
                            </span>
                            {current && current.currentPath && (
                                <span className={styles.heroDetail}>
                                    {currentDevice ?? 'Appareil'} — {current.currentPath}
                                </span>
                            )}
                        </div>
                    ) : share.devices.length === 0 ? (
                        <span className={styles.heroDetail}>Attache un premier appareil pour démarrer la synchro.</span>
                    ) : (
                        detail && <span className={styles.heroDetail}>{detail}</span>
                    )}
                </div>
            </div>

            <div className={styles.actions}>
                <Button variant='ghost' icon='server' onClick={() => setDialog('devices')}>
                    Appareils ({share.devices.length})
                </Button>
                <Button variant='ghost' icon='list' onClick={() => setDialog('exclusions')}>
                    Exclusions
                </Button>
                <Button variant='ghost' icon='clock' onClick={() => setDialog('versions')}>
                    Sauvegardes
                    {stats.versionCount > 0 && ` (${formatBytesFr(stats.versionBytes)})`}
                </Button>
                <Button variant='ghost' icon='logs' onClick={() => setDialog('logs')}>
                    Logs
                </Button>
                <Button variant='ghost' icon='settings' onClick={() => setDialog('settings')}>
                    Réglages
                </Button>
            </div>
            {error && <div className={styles.mutedNote}>{error}</div>}

            <DevicesDialog
                open={dialog === 'devices'}
                share={share}
                onClose={() => setDialog(null)}
                onChanged={onChanged}
            />
            <ExclusionsDialog
                open={dialog === 'exclusions'}
                share={share}
                onClose={() => setDialog(null)}
                onChanged={onChanged}
            />
            <VersionsBrowser
                open={dialog === 'versions'}
                share={share}
                onClose={() => setDialog(null)}
                onChanged={onChanged}
            />
            <LogsDialog open={dialog === 'logs'} share={share} onClose={() => setDialog(null)} />
            <SettingsDialog
                open={dialog === 'settings'}
                share={share}
                onClose={() => setDialog(null)}
                onChanged={onChanged}
                onDeleted={() => {
                    setDialog(null);
                    onChanged();
                }}
            />
        </section>
    );
}
