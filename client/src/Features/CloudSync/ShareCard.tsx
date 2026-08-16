import { useEffect, useState } from 'react';
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
import SnapshotsDialog from './SnapshotsDialog';
import VersionsBrowser from './VersionsBrowser';
import { stateLook } from './state';
import { useShareDevices } from './useShareDevices';
import { formatEta, useTransferRate } from './useTransferRate';
import styles from './style.module.css';
import type { LiveOutlineProps } from '@/live/useLiveOutline';

interface ShareCardProps {
    share: CloudSyncShare;
    onChanged: () => void;
    /**
     * Un dialogue de ce partage s'ouvre ou se ferme. Remonté plutôt que déclaré
     * ici : le niveau de présence doit être annoncé par **un seul** composant,
     * sinon la carte fermée effacerait au démontage ce que la carte ouverte
     * vient de poser.
     */
    onOpenChange: (shareId: number, open: boolean) => void;
    outline: LiveOutlineProps;
}

/**
 * La carte d'un partage : le héros d'état (gros badge « Synchronisé » vert,
 * ou synchro en cours avec barre de progression et fichier courant), puis une
 * rangée d'actions discrètes.
 */
export default function ShareCard({ share, onChanged, onOpenChange, outline }: ShareCardProps) {
    const { stateFor, progressFor } = useCloudSyncLive();
    const [dialog, setDialog] = useState<
        'devices' | 'exclusions' | 'versions' | 'snapshots' | 'logs' | 'settings' | null
    >(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        onOpenChange(share.id, dialog !== null);
    }, [dialog, share.id, onOpenChange]);

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
    // Nom pris sur le vif : figé dans `share`, il gardait l'ancien nom après un
    // renommage jusqu'au prochain rechargement de la page.
    const shareDevices = useShareDevices(share);
    const currentDevice = current ? shareDevices.find((d) => d.deviceId === current.deviceId)?.deviceName : null;
    const { rate, etaSeconds } = useTransferRate(bytesDone, bytesTotal);
    // Sous-barre du fichier en cours : sans elle, un fichier de plusieurs Go
    // laisse la barre globale immobile et l'utilisateur croit à un blocage.
    const filePercent =
        current && current.currentTotal > 0
            ? Math.min(100, Math.round((current.currentBytes / current.currentTotal) * 100))
            : null;

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
        <section className={styles.card} {...outline}>
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
                            {(rate !== null || etaSeconds !== null) && (
                                <span className={styles.heroDetail}>
                                    {rate !== null && `${formatBytesFr(Math.round(rate))}/s`}
                                    {rate !== null && etaSeconds !== null && ' · '}
                                    {etaSeconds !== null && `${formatEta(etaSeconds)} restantes`}
                                </span>
                            )}
                            {current && current.currentPath && (
                                <span className={styles.heroDetail}>
                                    {currentDevice ?? 'Appareil'} — {current.currentPath}
                                    {filePercent !== null && ` (${filePercent} %)`}
                                </span>
                            )}
                        </div>
                    ) : shareDevices.length === 0 ? (
                        <span className={styles.heroDetail}>Attache un premier appareil pour démarrer la synchro.</span>
                    ) : (
                        detail && <span className={styles.heroDetail}>{detail}</span>
                    )}
                </div>
            </div>

            <div className={styles.actions}>
                <Button variant='ghost' icon='server' onClick={() => setDialog('devices')}>
                    Appareils ({shareDevices.length})
                </Button>
                <Button variant='ghost' icon='list' onClick={() => setDialog('exclusions')}>
                    Exclusions
                </Button>
                <Button variant='ghost' icon='clock' onClick={() => setDialog('versions')}>
                    Sauvegardes
                    {stats.versionCount > 0 && ` (${formatBytesFr(stats.versionBytes)})`}
                </Button>
                <Button variant='ghost' icon='archive' onClick={() => setDialog('snapshots')}>
                    Restauration
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
            <SnapshotsDialog
                open={dialog === 'snapshots'}
                share={share}
                onClose={() => setDialog(null)}
                onChanged={onChanged}
            />
            <LogsDialog open={dialog === 'logs'} share={share} onClose={() => setDialog(null)} onChanged={onChanged} />
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
