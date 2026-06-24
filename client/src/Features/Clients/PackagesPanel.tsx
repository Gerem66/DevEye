import { useEffect, useState } from 'react';
import { ws } from '@/api/ws';
import { acquireMetrics } from '@/stores/metricsSubscription';
import Button from '@/Components/Button';
import {
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    type PackageDonePush,
    type PackageListPush,
    type PackageManager,
    type PackageManagerId,
    type PackageProgressPush
} from 'deveye-types';
import styles from './Clients.module.css';

/** Human label per manager id. */
const MANAGER_LABELS: Record<PackageManagerId, string> = {
    apt: 'APT',
    dnf: 'DNF',
    pacman: 'Pacman',
    pamac: 'Pamac',
    flatpak: 'Flatpak',
    snap: 'Snap',
    zypper: 'Zypper',
    brew: 'Homebrew',
    softwareupdate: 'Mises à jour macOS',
    winget: 'Winget',
    windowsupdate: 'Windows Update'
};

interface UpgradeState {
    manager: PackageManagerId;
    percent: number | null;
    line: string;
    done: boolean;
    ok?: boolean;
    rebootRequired?: boolean;
    error?: string;
}

/**
 * Live package-update panel for one device. Subscribes to the device's push
 * stream, asks the agent to enumerate its managers, and drives an upgrade with
 * live progress (percent when the tool emits it, else the latest output line).
 */
export function PackagesPanel({ deviceId }: { deviceId: string }) {
    const [managers, setManagers] = useState<PackageManager[] | null>(null);
    const [up, setUp] = useState<UpgradeState | null>(null);

    // Ref-counted live subscription (released on unmount).
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === PACKAGE_LIST_EVENT && msg.payload.ok) {
                const d = msg.payload.data as PackageListPush;
                if (d.deviceId === deviceId) setManagers(d.managers);
            } else if (msg.command === PACKAGE_PROGRESS_EVENT && msg.payload.ok) {
                const d = msg.payload.data as PackageProgressPush;
                if (d.deviceId === deviceId) {
                    setUp((p) =>
                        p && p.manager === d.manager ? { ...p, percent: d.percent ?? p.percent, line: d.line } : p
                    );
                }
            } else if (msg.command === PACKAGE_DONE_EVENT && msg.payload.ok) {
                const d = msg.payload.data as PackageDonePush;
                if (d.deviceId === deviceId) {
                    setUp((p) =>
                        p && p.manager === d.manager
                            ? { ...p, done: true, ok: d.ok, rebootRequired: d.rebootRequired, error: d.error }
                            : p
                    );
                }
            }
        });
        void ws.send('device.listPackages', { deviceId }).catch(() => setManagers([]));
        return off;
    }, [deviceId]);

    const upgrade = (manager: PackageManagerId) => {
        setUp({ manager, percent: null, line: 'Démarrage…', done: false });
        void ws.send('device.upgradePackages', { deviceId, manager }).catch((e) => {
            setUp({
                manager,
                percent: null,
                line: '',
                done: true,
                ok: false,
                error: e instanceof Error ? e.message : 'Échec'
            });
        });
    };

    if (managers === null) {
        return <p className={styles.pkgHint}>Détection des gestionnaires en cours…</p>;
    }
    if (managers.length === 0) {
        return <p className={styles.pkgHint}>Aucun gestionnaire de mises à jour détecté sur cet appareil.</p>;
    }

    const busy = up !== null && !up.done;
    const sorted = [...managers].sort((a, b) => (b.pendingCount ?? 0) - (a.pendingCount ?? 0));

    return (
        <div className={styles.pkgList}>
            {sorted.map((m) => {
                const pending = m.pendingCount;
                const active = up?.manager === m.id;
                return (
                    <div key={m.id} className={styles.pkgRow}>
                        <div className={styles.pkgRowHead}>
                            <span className={styles.pkgName}>{MANAGER_LABELS[m.id]}</span>
                            <span className={styles.pkgCount}>
                                {pending === null
                                    ? 'comptage inconnu'
                                    : pending === 0
                                      ? 'à jour'
                                      : `${pending} mise(s) à jour`}
                                {m.needsRoot && <span className={styles.pkgRoot}> · root</span>}
                            </span>
                            <Button variant='secondary' disabled={busy || pending === 0} onClick={() => upgrade(m.id)}>
                                {active && busy ? 'En cours…' : 'Mettre à jour'}
                            </Button>
                        </div>

                        {active && up && (
                            <div className={styles.pkgProgress}>
                                <div className={styles.pkgBar}>
                                    <div
                                        className={`${styles.pkgBarFill} ${up.percent === null && !up.done ? styles.pkgBarIndet : ''}`}
                                        style={up.percent !== null ? { width: `${up.percent}%` } : undefined}
                                    />
                                </div>
                                {up.done ? (
                                    <p className={up.ok ? styles.pkgOk : styles.pkgErr}>
                                        {up.ok
                                            ? `Terminé${up.rebootRequired ? ' — redémarrage requis' : ''}`
                                            : `Échec — ${up.error ?? 'erreur inconnue'}`}
                                    </p>
                                ) : (
                                    <code className={styles.pkgLine}>{up.line}</code>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
