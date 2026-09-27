import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { acquireMetrics, Button, onServerEvent, WsError } from 'deveye-sdk-client';
import {
    isManagedPackageManager,
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    PACKAGE_STARTED_EVENT,
    packageDonePushSchema,
    packageListPushSchema,
    packageProgressPushSchema,
    packageStartedPushSchema,
    type PackageManager,
    type PackageManagerId,
    type UnmanagedUpdaterId
} from '@deveye/types';

import { agent } from './api';
import styles from './style.module.css';

/** Nom et rôle de chaque outil, dans l'ordre du tableau : le système d'abord, les applications ensuite. */
const MANAGERS: Record<PackageManagerId, { label: string; desc: string }> = {
    apt: { label: 'APT', desc: 'Paquets du système (Debian, Ubuntu)' },
    dnf: { label: 'DNF', desc: 'Paquets du système (Fedora, RHEL)' },
    pacman: { label: 'Pacman', desc: 'Paquets du système (Arch)' },
    pamac: { label: 'Pamac', desc: 'Paquets du système et AUR (Manjaro)' },
    zypper: { label: 'Zypper', desc: 'Paquets du système (openSUSE)' },
    softwareupdate: { label: 'Mises à jour macOS', desc: 'Système macOS' },
    windowsupdate: { label: 'Windows Update', desc: 'Système Windows' },
    flatpak: { label: 'Flatpak', desc: 'Applications Flatpak' },
    snap: { label: 'Snap', desc: 'Applications Snap' },
    brew: { label: 'Homebrew', desc: 'Outils installés par Homebrew' },
    winget: { label: 'Winget', desc: 'Applications Windows' }
};

const UNMANAGED: Record<UnmanagedUpdaterId, { label: string; desc: string }> = {
    'rpm-ostree': { label: 'rpm-ostree', desc: 'Image du système (Fedora Atomic)' },
    bootc: { label: 'bootc', desc: 'Image du système' },
    fwupd: { label: 'fwupd', desc: 'Micrologiciels de la machine' },
    nix: { label: 'Nix', desc: 'Paquets Nix' },
    apk: { label: 'APK', desc: 'Paquets du système (Alpine)' },
    xbps: { label: 'XBPS', desc: 'Paquets du système (Void)' },
    emerge: { label: 'Portage', desc: 'Paquets du système (Gentoo)' },
    eopkg: { label: 'eopkg', desc: 'Paquets du système (Solus)' },
    mas: { label: 'Mac App Store', desc: 'Applications de l’App Store' },
    macports: { label: 'MacPorts', desc: 'Outils installés par MacPorts' },
    choco: { label: 'Chocolatey', desc: 'Applications Windows' },
    scoop: { label: 'Scoop', desc: 'Outils en ligne de commande' }
};

const ORDER = Object.keys(MANAGERS) as PackageManagerId[];

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

type Managed = PackageManager & { id: PackageManagerId };
type Unmanaged = PackageManager & { id: UnmanagedUpdaterId };

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Les mises à jour du système et des applications d'un appareil, en un tableau :
 * chaque outil que DevEye pilote avec son compte et son bouton, puis, grisés, ceux
 * qu'il reconnaît sans les piloter. L'avancement ne vient jamais du clic mais des
 * événements du serveur (`package.started`, `.progress`, `.done`) et de la liste :
 * une mise à jour lancée ailleurs s'affiche de la même façon.
 */
export function PackagesPanel({ deviceId, privileged }: { deviceId: string; privileged: boolean | null }) {
    const [managers, setManagers] = useState<PackageManager[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    /** Avancement par gestionnaire : plusieurs peuvent tourner si lancés ailleurs. */
    const [upgrades, setUpgrades] = useState<Partial<Record<PackageManagerId, UpgradeState>>>({});
    const [refreshing, setRefreshing] = useState(false);
    /**
     * « Tout mettre à jour » : la file des outils restants, enchaînés un à un à
     * chaque `package.done`. Elle vit avec la fenêtre : la fermer laisse finir
     * l'outil en cours, sans lancer les suivants.
     */
    const [queue, setQueue] = useState<{ ids: PackageManagerId[]; total: number } | null>(null);
    const queueRef = useRef(queue);
    queueRef.current = queue;
    const managersRef = useRef(managers);
    managersRef.current = managers;
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
            setListError('L’agent n’a pas répondu : la détection a peut-être échoué sur l’appareil.');
        });
        agent.send('agent.listPackages', { deviceId }).catch((e: unknown) => {
            // La raison vient du serveur (agent hors ligne, droits…) : l'afficher
            // telle quelle plutôt qu'un « aucun gestionnaire détecté » faux.
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
            setRefreshing(false);
            setListError(e instanceof Error ? e.message : 'Détection impossible.');
        });
    }, [deviceId, armDetect]);

    const startUpgrade = useCallback(
        (manager: PackageManagerId) => {
            // Optimiste : le `package.started` du serveur fait foi.
            setUpgrades((prev) => ({ ...prev, [manager]: { percent: null, line: 'Démarrage…', done: false } }));
            agent.send('agent.upgradePackages', { deviceId, manager }).catch((e: unknown) => {
                // `conflict` : une mise à jour tourne, simplement pas la nôtre. On
                // montre celle qui tourne, pas un échec.
                if (e instanceof WsError && e.code === 'conflict') {
                    setUpgrades((prev) => ({ ...prev, [manager]: prev[manager] ?? ALREADY_RUNNING }));
                    return;
                }
                setQueue(null);
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
        },
        [deviceId]
    );

    /** L'outil suivant de la file, s'il a encore quelque chose à appliquer. */
    const advanceQueue = useCallback(
        (finished: PackageManagerId) => {
            const current = queueRef.current;
            if (!current || current.ids[0] !== finished) return;
            const rest = current.ids.slice(1).filter((id) => {
                const m = managersRef.current?.find((x) => x.id === id);
                return m === undefined || m.pendingCount !== 0;
            });
            if (rest.length === 0) {
                setQueue(null);
                return;
            }
            setQueue({ ids: rest, total: current.total });
            startUpgrade(rest[0]);
        },
        [startUpgrade]
    );

    useEffect(() => {
        // Changer d'appareil sans démonter ne doit pas laisser l'inventaire du
        // précédent.
        setManagers(null);
        setUpgrades({});
        setRefreshing(false);
        setQueue(null);
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
                advanceQueue(d.manager);
            })
        ];
        requestList();
        return () => {
            offs.forEach((off) => off());
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
        };
    }, [deviceId, requestList, armDetect, advanceQueue]);

    const refresh = () => {
        setRefreshing(true);
        requestList();
    };

    if (listError !== null && managers === null) {
        return (
            <div className={styles.pkgPanel}>
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
                Détection des systèmes de mises à jour… (elle interroge chaque outil présent et peut prendre une minute)
            </p>
        );
    }

    const managed = managers
        .filter((m): m is Managed => isManagedPackageManager(m.id))
        .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    const unmanaged = managers.filter((m): m is Unmanaged => !isManagedPackageManager(m.id));

    // Une seule mise à jour à la fois par appareil : deux gestionnaires système
    // se disputeraient le verrou de paquets de l'OS.
    const busy = Object.values(upgrades).some((u) => u && !u.done);
    // Root requis sans l'avoir : l'agent refuserait, autant le dire ici.
    const rootMissing = (m: Managed) => m.needsRoot && privileged === false;
    const eligible = managed.filter((m) => (m.pendingCount ?? 0) > 0 && !rootMissing(m));
    const total = managed.reduce((sum, m) => sum + (m.pendingCount ?? 0), 0);
    const unknown = managed.some((m) => m.pendingCount === null);
    const rebootRequired = managed.some((m) => m.rebootRequired);

    const updateAll = () => {
        const ids = eligible.map((m) => m.id);
        if (ids.length === 0) return;
        setQueue({ ids, total: ids.length });
        startUpgrade(ids[0]);
    };

    return (
        <div className={styles.pkgPanel}>
            <div className={styles.pkgSummary}>
                <div className={styles.pkgSummaryText}>
                    <span className={`${styles.pkgTotal} ${total > 0 ? styles.pkgTotalPending : ''}`}>
                        {refreshing ? 'Actualisation…' : plural(total, 'mise à jour', 'mises à jour')}
                    </span>
                    <span className={styles.pkgSummaryHint}>
                        {managed.length === 0
                            ? 'Aucun système de mises à jour que DevEye sache piloter sur cet appareil.'
                            : total > 0
                              ? 'Disponibles sur l’appareil, à appliquer outil par outil ou toutes d’un coup.'
                              : unknown
                                ? 'Le compte de certains outils est inconnu.'
                                : 'Tout est à jour.'}
                        {rebootRequired && ' Un redémarrage est requis pour finir celles déjà appliquées.'}
                    </span>
                </div>
                <div className={styles.pkgSummaryActions}>
                    <Button variant='secondary' icon='refresh' onClick={refresh} disabled={refreshing || busy}>
                        Actualiser
                    </Button>
                    <Button onClick={updateAll} disabled={busy || eligible.length === 0}>
                        {queue
                            ? `En cours (${queue.total - queue.ids.length + 1}/${queue.total})…`
                            : 'Tout mettre à jour'}
                    </Button>
                </div>
            </div>

            {listError !== null && <p className={styles.pkgErr}>{listError}</p>}

            {managers.length > 0 && (
                <table className={styles.pkgTable}>
                    <thead>
                        <tr>
                            <th>Système</th>
                            <th className={styles.pkgCountCol}>Mises à jour</th>
                            <th aria-label='Action' />
                        </tr>
                    </thead>
                    <tbody>
                        {managed.map((m) => {
                            const meta = MANAGERS[m.id];
                            const state = upgrades[m.id];
                            const running = state !== undefined && !state.done;
                            const missing = rootMissing(m);
                            const pending = m.pendingCount;
                            return (
                                <Fragment key={m.id}>
                                    <tr>
                                        <td>
                                            <span className={styles.pkgName}>{meta.label}</span>
                                            <span className={styles.pkgDesc}>{meta.desc}</span>
                                            {missing && (
                                                <span className={styles.pkgReason}>
                                                    <span className='icon icon-lock' />
                                                    Root requis : élevez l’agent depuis sa popup « Agent »
                                                </span>
                                            )}
                                        </td>
                                        <td className={styles.pkgCountCol}>
                                            <span
                                                className={`${styles.pkgCount} ${pending !== null && pending > 0 ? styles.pkgCountPending : ''}`}
                                                title={
                                                    pending === null
                                                        ? 'Compte inconnu : l’outil ne l’a pas donné'
                                                        : undefined
                                                }
                                            >
                                                {refreshing ? '…' : pending === null ? '?' : pending}
                                            </span>
                                        </td>
                                        <td className={styles.pkgActionCol}>
                                            <Button
                                                variant='secondary'
                                                disabled={busy || pending === 0 || missing}
                                                onClick={() => startUpgrade(m.id)}
                                                title={
                                                    running
                                                        ? 'Mise à jour en cours sur l’appareil'
                                                        : busy
                                                          ? 'Une autre mise à jour est en cours sur cet appareil'
                                                          : pending === 0
                                                            ? 'Rien à mettre à jour'
                                                            : undefined
                                                }
                                            >
                                                {running ? 'En cours…' : 'Mettre à jour'}
                                            </Button>
                                        </td>
                                    </tr>
                                    {state && (
                                        <tr className={styles.pkgProgressRow}>
                                            <td colSpan={3}>
                                                <div className={styles.pkgBar}>
                                                    <div
                                                        className={[
                                                            styles.pkgBarFill,
                                                            state.percent === null && !state.done
                                                                ? styles.pkgBarIndet
                                                                : '',
                                                            state.done
                                                                ? state.ok
                                                                    ? styles.pkgBarOk
                                                                    : styles.pkgBarErr
                                                                : ''
                                                        ]
                                                            .filter(Boolean)
                                                            .join(' ')}
                                                        style={
                                                            state.percent !== null
                                                                ? { width: `${state.percent}%` }
                                                                : undefined
                                                        }
                                                    />
                                                </div>
                                                {state.done ? (
                                                    <p className={state.ok ? styles.pkgOk : styles.pkgErr}>
                                                        {state.ok
                                                            ? `Terminé${state.rebootRequired ? ' : redémarrage requis' : ''}`
                                                            : `Échec : ${state.error ?? 'erreur inconnue'}`}
                                                    </p>
                                                ) : (
                                                    <code className={styles.pkgLine}>{state.line}</code>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                        {unmanaged.map((m) => {
                            const meta = UNMANAGED[m.id];
                            return (
                                <tr key={m.id} className={styles.pkgUnmanaged}>
                                    <td>
                                        <span className={styles.pkgName}>{meta.label}</span>
                                        <span className={styles.pkgDesc}>{meta.desc}</span>
                                    </td>
                                    <td className={styles.pkgCountCol} colSpan={2}>
                                        Détecté, pas géré par DevEye
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
