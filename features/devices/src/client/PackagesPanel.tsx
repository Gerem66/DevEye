import { useCallback, useEffect, useRef, useState } from 'react';
import { acquireMetrics, Button, onServerEvent, WsError } from 'deveye-sdk-client';
import {
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    PACKAGE_STARTED_EVENT,
    packageDonePushSchema,
    packageListPushSchema,
    packageProgressPushSchema,
    packageStartedPushSchema,
    type PackageManager,
    type PackageManagerId
} from '@deveye/types';

import { agent } from './api';
import styles from './style.module.css';

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

/**
 * Au-delà de quoi on cesse d'attendre l'inventaire : certains gestionnaires sont
 * lents (`softwareupdate -l`, le verrou dpkg), et ce délai couvre la somme des
 * sondes que l'agent plafonne une à une.
 */
const DETECT_TIMEOUT_MS = 150_000;

interface UpgradeState {
    percent: number | null;
    line: string;
    done: boolean;
    ok?: boolean;
    rebootRequired?: boolean;
    error?: string;
}

/** Ce qu'on affiche d'une mise à jour qu'on découvre déjà lancée (ailleurs). */
const ALREADY_RUNNING: UpgradeState = { percent: null, line: 'Mise à jour en cours…', done: false };

/**
 * Live package-update panel for one device: the agent enumerates its managers,
 * an upgrade runs with live progress. L'état d'avancement ne vient jamais du
 * clic mais des événements du serveur (`package.started`, `.progress`, `.done`)
 * et de la liste : une mise à jour lancée ailleurs s'affiche de la même façon.
 */
export function PackagesPanel({ deviceId, privileged }: { deviceId: string; privileged: boolean | null }) {
    const [managers, setManagers] = useState<PackageManager[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    /** Avancement par gestionnaire — plusieurs peuvent tourner si lancés ailleurs. */
    const [upgrades, setUpgrades] = useState<Partial<Record<PackageManagerId, UpgradeState>>>({});
    const [refreshing, setRefreshing] = useState(false);
    const detectTimer = useRef<number | null>(null);

    // Ref-counted live subscription (released on unmount).
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    /** Arme l'échéance d'attente d'un inventaire (une seule à la fois). */
    const armDetect = useCallback((onTimeout: () => void) => {
        if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
        detectTimer.current = window.setTimeout(onTimeout, DETECT_TIMEOUT_MS);
    }, []);

    const requestList = useCallback(() => {
        setListError(null);
        armDetect(() => {
            setRefreshing(false);
            setListError('L’agent n’a pas répondu — la détection a peut-être échoué sur l’appareil.');
        });
        agent.send('agent.listPackages', { deviceId }).catch((e: unknown) => {
            // La raison vient du serveur (agent hors ligne, droits…) : l'afficher
            // telle quelle plutôt qu'un « aucun gestionnaire détecté » faux.
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
            setRefreshing(false);
            setListError(e instanceof Error ? e.message : 'Détection impossible.');
        });
    }, [deviceId, armDetect]);

    useEffect(() => {
        // Changer d'appareil sans démonter ne doit pas laisser l'inventaire du
        // précédent.
        setManagers(null);
        setUpgrades({});
        setRefreshing(false);
        const offs = [
            onServerEvent(PACKAGE_LIST_EVENT, packageListPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
                setManagers(d.managers);
                setListError(null);
                setRefreshing(false);
                // Le serveur joint ce qui tourne déjà : le verrou est visible
                // quand on (r)ouvre la fenêtre en cours de route.
                setUpgrades((prev) => {
                    const next = { ...prev };
                    for (const manager of d.running) next[manager] = next[manager] ?? ALREADY_RUNNING;
                    return next;
                });
            }),
            onServerEvent(PACKAGE_STARTED_EVENT, packageStartedPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setUpgrades((prev) => ({ ...prev, [d.manager]: { percent: null, line: 'Démarrage…', done: false } }));
            }),
            onServerEvent(PACKAGE_PROGRESS_EVENT, packageProgressPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setUpgrades((prev) => {
                    const current = prev[d.manager] ?? ALREADY_RUNNING;
                    return {
                        ...prev,
                        [d.manager]: { ...current, done: false, percent: d.percent ?? current.percent, line: d.line }
                    };
                });
            }),
            onServerEvent(PACKAGE_DONE_EVENT, packageDonePushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setUpgrades((prev) => ({
                    ...prev,
                    [d.manager]: {
                        // Une commande terminée remplit sa barre, sinon elle
                        // reste affichée et vide.
                        percent: 100,
                        line: prev[d.manager]?.line ?? '',
                        done: true,
                        ok: d.ok,
                        rebootRequired: d.rebootRequired,
                        error: d.error
                    }
                }));
                // Le serveur relance l'inventaire pour tous les abonnés : on
                // l'attend sans le redemander, chaque demande est une détection
                // sur la machine.
                if (d.ok) {
                    setRefreshing(true);
                    armDetect(() => setRefreshing(false));
                }
            })
        ];
        requestList();
        return () => {
            offs.forEach((off) => off());
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
        };
    }, [deviceId, requestList, armDetect]);

    const upgrade = (manager: PackageManagerId) => {
        // Optimiste : le `package.started` du serveur fait foi.
        setUpgrades((prev) => ({ ...prev, [manager]: { percent: null, line: 'Démarrage…', done: false } }));
        agent.send('agent.upgradePackages', { deviceId, manager }).catch((e: unknown) => {
            // `conflict` : une mise à jour tourne, simplement pas la nôtre. On
            // montre celle qui tourne, pas un échec.
            if (e instanceof WsError && e.code === 'conflict') {
                setUpgrades((prev) => ({ ...prev, [manager]: prev[manager] ?? ALREADY_RUNNING }));
                return;
            }
            setUpgrades((prev) => ({
                ...prev,
                [manager]: {
                    percent: 100,
                    line: '',
                    done: true,
                    ok: false,
                    error: e instanceof Error ? e.message : 'Échec'
                }
            }));
        });
    };

    if (listError !== null && managers === null) {
        return (
            <div className={styles.pkgList}>
                <p className={styles.pkgErr}>{listError}</p>
                <div>
                    <Button variant='secondary' onClick={requestList}>
                        Réessayer
                    </Button>
                </div>
            </div>
        );
    }
    if (managers === null) {
        return (
            <p className={styles.pkgHint}>
                Détection des gestionnaires en cours… (elle interroge chaque outil présent et peut prendre une minute)
            </p>
        );
    }
    if (managers.length === 0) {
        return <p className={styles.pkgHint}>Aucun gestionnaire de mises à jour détecté sur cet appareil.</p>;
    }

    // Une seule mise à jour à la fois par appareil : deux gestionnaires système
    // se disputeraient le verrou de paquets de l'OS.
    const busy = Object.values(upgrades).some((u) => u && !u.done);
    const sorted = [...managers].sort((a, b) => (b.pendingCount ?? 0) - (a.pendingCount ?? 0));

    return (
        <div className={styles.pkgList}>
            {listError !== null && <p className={styles.pkgErr}>{listError}</p>}
            {sorted.map((m) => {
                const pending = m.pendingCount;
                const state = upgrades[m.id];
                const running = state !== undefined && !state.done;
                // Root requis sans l'avoir : l'agent refuserait, autant le dire ici.
                const rootMissing = m.needsRoot && privileged === false;
                const disabled = busy || pending === 0 || rootMissing;
                return (
                    <div key={m.id} className={styles.pkgRow}>
                        <div className={styles.pkgRowHead}>
                            <span className={styles.pkgName}>{MANAGER_LABELS[m.id]}</span>
                            <span className={styles.pkgCount}>
                                {refreshing
                                    ? 'actualisation…'
                                    : pending === null
                                      ? 'comptage inconnu'
                                      : pending === 0
                                        ? 'à jour'
                                        : `${pending} mise(s) à jour`}
                                {m.needsRoot && <span className={styles.pkgRoot}> · root</span>}
                                {m.rebootRequired && <span className={styles.pkgRoot}> · redémarrage requis</span>}
                            </span>
                            <Button
                                variant='secondary'
                                disabled={disabled}
                                onClick={() => upgrade(m.id)}
                                title={
                                    rootMissing
                                        ? 'Agent non privilégié — élevez-le en service système (root)'
                                        : running
                                          ? 'Mise à jour en cours sur l’appareil'
                                          : busy
                                            ? 'Une autre mise à jour est en cours sur cet appareil'
                                            : undefined
                                }
                            >
                                {running ? 'En cours…' : 'Mettre à jour'}
                            </Button>
                        </div>

                        {state && (
                            <div className={styles.pkgProgress}>
                                <div className={styles.pkgBar}>
                                    <div
                                        className={[
                                            styles.pkgBarFill,
                                            state.percent === null && !state.done ? styles.pkgBarIndet : '',
                                            state.done ? (state.ok ? styles.pkgBarOk : styles.pkgBarErr) : ''
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                        style={state.percent !== null ? { width: `${state.percent}%` } : undefined}
                                    />
                                </div>
                                {state.done ? (
                                    <p className={state.ok ? styles.pkgOk : styles.pkgErr}>
                                        {state.ok
                                            ? `Terminé${state.rebootRequired ? ' — redémarrage requis' : ''}`
                                            : `Échec — ${state.error ?? 'erreur inconnue'}`}
                                    </p>
                                ) : (
                                    <code className={styles.pkgLine}>{state.line}</code>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
