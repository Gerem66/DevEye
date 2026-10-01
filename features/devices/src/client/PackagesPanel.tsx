import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { acquireMetrics, Button, Checkbox, onServerEvent, WsError } from 'deveye-sdk-client';
import {
    isManagedPackageManager,
    PACKAGE_COUNT_EVENT,
    PACKAGE_DONE_EVENT,
    PACKAGE_LIST_EVENT,
    PACKAGE_PROGRESS_EVENT,
    PACKAGE_STARTED_EVENT,
    packageCountPushSchema,
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
 * Au-delà de quoi on cesse d'attendre, la liste des outils puis leurs comptes :
 * certaines sondes sont lentes (`softwareupdate -l`, le verrou dpkg), et ce
 * délai couvre leur somme, l'agent les plafonnant une à une.
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

/** Le compte de chaque outil : absent tant que sa sonde n'a pas répondu, `null` si elle n'a rien donné. */
type Counts = Partial<Record<PackageManagerId, number | null>>;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Les mises à jour du système et des applications d'un appareil, en un tableau.
 * L'agent répond en deux temps : les outils présents aussitôt, puis le compte
 * de chacun à mesure que sa sonde finit, et chaque ligne tourne en attendant
 * le sien. Ceux que DevEye pilote se cochent (ceux qui ont des mises à jour le
 * sont d'office) et le bouton sous le tableau les enchaîne un à un ; ceux
 * qu'il reconnaît sans les piloter suivent, grisés. L'avancement ne vient
 * jamais du clic mais des événements du serveur (`package.started`, `.progress`,
 * `.done`) et de la liste : une mise à jour lancée ailleurs s'affiche de la
 * même façon.
 */
export function PackagesPanel({ deviceId, privileged }: { deviceId: string; privileged: boolean | null }) {
    const [managers, setManagers] = useState<PackageManager[] | null>(null);
    const [counts, setCounts] = useState<Counts>({});
    const [listError, setListError] = useState<string | null>(null);
    /** Avancement par gestionnaire : plusieurs peuvent tourner si lancés ailleurs. */
    const [upgrades, setUpgrades] = useState<Partial<Record<PackageManagerId, UpgradeState>>>({});
    const [selected, setSelected] = useState<Set<PackageManagerId>>(new Set());
    /**
     * La file des outils cochés restants, enchaînés un à un à chaque
     * `package.done`. Elle vit avec la fenêtre : la fermer laisse finir l'outil
     * en cours, sans lancer les suivants.
     */
    const [queue, setQueue] = useState<{ ids: PackageManagerId[]; total: number } | null>(null);
    const queueRef = useRef(queue);
    queueRef.current = queue;
    const managersRef = useRef(managers);
    managersRef.current = managers;
    const countsRef = useRef(counts);
    countsRef.current = counts;
    const privilegedRef = useRef(privileged);
    privilegedRef.current = privileged;
    const detectTimer = useRef<number | null>(null);

    // Ref-counted live subscription (released on unmount).
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const disarmDetect = useCallback(() => {
        if (detectTimer.current === null) return;
        window.clearTimeout(detectTimer.current);
        detectTimer.current = null;
    }, []);

    /** Arme l'échéance d'attente (une seule à la fois). */
    const armDetect = useCallback(() => {
        disarmDetect();
        detectTimer.current = window.setTimeout(() => {
            detectTimer.current = null;
            const known = managersRef.current;
            if (known === null) {
                setListError('L’agent n’a pas répondu : la détection a peut-être échoué sur l’appareil.');
                return;
            }
            // Les comptes jamais arrivés passent « inconnu » : aucune ligne ne
            // tourne pour rien.
            setCounts((prev) => {
                const next = { ...prev };
                for (const m of known) {
                    if (isManagedPackageManager(m.id) && next[m.id] === undefined) next[m.id] = null;
                }
                return next;
            });
            setListError('Certains outils n’ont pas répondu : leur compte est inconnu.');
        }, DETECT_TIMEOUT_MS);
    }, [disarmDetect]);

    const requestList = useCallback(() => {
        setListError(null);
        armDetect();
        agent.send('agent.listPackages', { deviceId }).catch((e: unknown) => {
            // La raison vient du serveur (agent hors ligne, droits…) : l'afficher
            // telle quelle plutôt qu'un « aucun gestionnaire détecté » faux.
            disarmDetect();
            setListError(e instanceof Error ? e.message : 'Détection impossible.');
        });
    }, [deviceId, armDetect, disarmDetect]);

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
            const rest = current.ids.slice(1).filter((id) => countsRef.current[id] !== 0);
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
        setCounts({});
        setSelected(new Set());
        setUpgrades({});
        setQueue(null);
        const offs = [
            onServerEvent(PACKAGE_LIST_EVENT, packageListPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setManagers(d.managers);
                setCounts({});
                setSelected(new Set());
                setListError(null);
                // Une liste relancée par le serveur (après une mise à jour) n'a
                // pas d'échéance : ses comptes en ont besoin autant que les autres.
                if (detectTimer.current === null) armDetect();
                // Le serveur joint ce qui tourne déjà : le verrou est visible
                // quand on (r)ouvre la fenêtre en cours de route.
                setUpgrades((prev) => {
                    const next = { ...prev };
                    for (const manager of d.running) next[manager] = next[manager] ?? ALREADY_RUNNING;
                    return next;
                });
            }),
            onServerEvent(PACKAGE_COUNT_EVENT, packageCountPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setCounts((prev) => ({ ...prev, [d.manager]: d.pendingCount }));
                // Coché d'office dès qu'il y a quelque chose à appliquer et que
                // l'agent le pourrait.
                const tool = managersRef.current?.find((m) => m.id === d.manager);
                const rootMissing = tool?.needsRoot === true && privilegedRef.current === false;
                const eligible = d.pendingCount !== null && d.pendingCount > 0 && !rootMissing;
                setSelected((prev) => {
                    const next = new Set(prev);
                    if (eligible) next.add(d.manager);
                    else next.delete(d.manager);
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
                advanceQueue(d.manager);
            })
        ];
        requestList();
        return () => {
            offs.forEach((off) => off());
            disarmDetect();
        };
    }, [deviceId, requestList, armDetect, disarmDetect, advanceQueue]);

    // Tous les comptes sont là : plus rien à attendre.
    useEffect(() => {
        if (managers === null) return;
        if (managers.some((m) => isManagedPackageManager(m.id) && counts[m.id] === undefined)) return;
        disarmDetect();
    }, [managers, counts, disarmDetect]);

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
        return <p className={styles.pkgHint}>Détection des outils présents sur l’appareil…</p>;
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
    // Cochable : rien ne l'interdit, et son compte n'est pas zéro (inconnu ou
    // encore attendu, il l'est). Pendant une file, les cases restent telles
    // quelles, figées : elles disent ce qui passe.
    const pickable = (m: Managed) => !rootMissing(m) && counts[m.id] !== 0;
    const choosable = managed.filter(pickable);
    const chosen = choosable.filter((m) => selected.has(m.id));
    const counting = managed.some((m) => counts[m.id] === undefined);
    const total = managed.reduce((sum, m) => sum + (counts[m.id] ?? 0), 0);
    const unknown = managed.some((m) => counts[m.id] === null);
    const rebootRequired = managed.some((m) => m.rebootRequired);

    const toggle = (id: PackageManagerId, on: boolean) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });

    const updateChosen = () => {
        const ids = chosen.map((m) => m.id);
        if (ids.length === 0) return;
        setQueue({ ids, total: ids.length });
        startUpgrade(ids[0]);
    };

    return (
        <div className={styles.pkgPanel}>
            <div className={styles.pkgSummary}>
                <span className={`${styles.pkgTotal} ${total > 0 ? styles.pkgTotalPending : ''}`}>
                    {counting ? 'Recherche des mises à jour…' : plural(total, 'mise à jour', 'mises à jour')}
                </span>
                <span className={styles.pkgSummaryHint}>
                    {managed.length === 0
                        ? 'Aucun système de mises à jour que DevEye sache piloter sur cet appareil.'
                        : counting
                          ? 'Chaque outil est interrogé à son tour : les comptes arrivent au fur et à mesure.'
                          : total > 0
                            ? 'Cochez les outils à mettre à jour, puis lancez-les d’un coup : ils s’enchaînent un à un.'
                            : unknown
                              ? 'Le compte de certains outils est inconnu.'
                              : 'Tout est à jour.'}
                    {rebootRequired && ' Un redémarrage est requis pour finir celles déjà appliquées.'}
                </span>
            </div>

            {listError !== null && <p className={styles.pkgErr}>{listError}</p>}

            {managers.length > 0 && (
                <table className={styles.pkgTable}>
                    <thead>
                        <tr>
                            <th className={styles.pkgSelectCol}>
                                {managed.length > 0 && (
                                    <Checkbox
                                        aria-label='Tout sélectionner'
                                        checked={choosable.length > 0 && chosen.length === choosable.length}
                                        disabled={busy || choosable.length === 0}
                                        onChange={(on) => setSelected(new Set(on ? choosable.map((m) => m.id) : []))}
                                    />
                                )}
                            </th>
                            <th>Système</th>
                            <th className={styles.pkgCountCol}>Mises à jour</th>
                        </tr>
                    </thead>
                    <tbody>
                        {managed.map((m) => {
                            const meta = MANAGERS[m.id];
                            const state = upgrades[m.id];
                            const missing = rootMissing(m);
                            const count = counts[m.id];
                            const picked = pickable(m) && selected.has(m.id);
                            const canPick = !busy && pickable(m);
                            return (
                                <Fragment key={m.id}>
                                    <tr
                                        className={[
                                            canPick ? styles.pkgRowSelectable : '',
                                            picked ? styles.pkgRowSelected : ''
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                        onClick={canPick ? () => toggle(m.id, !picked) : undefined}
                                    >
                                        {/* La case gère son clic : la ligne ne doit pas le rejouer. */}
                                        <td className={styles.pkgSelectCol} onClick={(e) => e.stopPropagation()}>
                                            <Checkbox
                                                aria-label={`Mettre à jour ${meta.label}`}
                                                checked={picked}
                                                disabled={!canPick}
                                                onChange={(on) => toggle(m.id, on)}
                                            />
                                        </td>
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
                                            {count === undefined ? (
                                                <span className={styles.pkgCounting}>
                                                    <span
                                                        className={`icon icon-spinner ${styles.spinning}`}
                                                        aria-hidden='true'
                                                    />
                                                    Recherche…
                                                </span>
                                            ) : (
                                                <span
                                                    className={`${styles.pkgCount} ${count !== null && count > 0 ? styles.pkgCountPending : ''}`}
                                                    title={
                                                        count === null
                                                            ? 'Compte inconnu : l’outil ne l’a pas donné'
                                                            : undefined
                                                    }
                                                >
                                                    {count === null ? '?' : count}
                                                </span>
                                            )}
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
                                    <td className={styles.pkgSelectCol} />
                                    <td>
                                        <span className={styles.pkgName}>{meta.label}</span>
                                        <span className={styles.pkgDesc}>{meta.desc}</span>
                                    </td>
                                    <td className={styles.pkgCountCol}>Détecté, pas géré par DevEye</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}

            <div className={styles.pkgActions}>
                <Button variant='secondary' icon='refresh' onClick={requestList} disabled={counting || busy}>
                    Actualiser
                </Button>
                <Button onClick={updateChosen} disabled={busy || chosen.length === 0}>
                    {queue
                        ? `En cours (${queue.total - queue.ids.length + 1}/${queue.total})…`
                        : chosen.length > 0
                          ? `Mettre à jour ${plural(chosen.length, 'outil', 'outils')}`
                          : 'Mettre à jour'}
                </Button>
            </div>
        </div>
    );
}
