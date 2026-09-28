import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { acquireMetrics, Button, ConfirmDialog, onServerEvent, SegmentedControl, StatusBadge } from 'deveye-sdk-client';
import type { ConfirmRequest } from 'deveye-sdk-client';
import {
    DEVICE_DOCKER_DONE_EVENT,
    DEVICE_DOCKER_INVENTORY_EVENT,
    DEVICE_DOCKER_PROGRESS_EVENT,
    DEVICE_DOCKER_STATS_EVENT,
    deviceDockerDonePushSchema,
    deviceDockerInventoryPushSchema,
    deviceDockerProgressPushSchema,
    deviceDockerStatsPushSchema,
    type ContainerEngine,
    type ContainerState,
    type DockerAction,
    type DockerContainer,
    type DockerInventory,
    type DockerStat
} from '@deveye/types';

import { agent } from './api';
import { MiniGraph, type Series } from './MiniGraph';
import { formatBytesFr } from './utils';
import styles from './style.module.css';

/** Au-delà de quoi on cesse d'attendre l'inventaire : les sondes sont plafonnées une à une. */
const DETECT_TIMEOUT_MS = 60_000;

/** Cadence du relevé de stats, comme la vue live des journaux. */
const STATS_INTERVAL_MS = 3000;

/**
 * Longueur de la série glissante par conteneur : rien n'est stocké, les
 * graphiques ne vivent que le temps où le panneau est ouvert.
 */
const SERIES_POINTS = 60;

/** Lignes de sortie retenues d'une action en cours. */
const MAX_LOG_LINES = 500;

type Tab = 'containers' | 'images' | 'volumes' | 'networks';

const TABS = [
    { value: 'containers' as const, label: 'Conteneurs' },
    { value: 'images' as const, label: 'Images' },
    { value: 'volumes' as const, label: 'Volumes' },
    { value: 'networks' as const, label: 'Réseaux' }
];

const STATE_LABELS: Record<ContainerState, string> = {
    running: 'En marche',
    exited: 'Arrêté',
    paused: 'En pause',
    created: 'Créé',
    restarting: 'Redémarrage',
    removing: 'Suppression',
    dead: 'Mort',
    unknown: 'Inconnu'
};

const STATE_TONES: Record<ContainerState, 'online' | 'offline' | 'warning' | 'danger' | 'neutral'> = {
    running: 'online',
    exited: 'offline',
    paused: 'warning',
    created: 'neutral',
    restarting: 'warning',
    removing: 'warning',
    dead: 'danger',
    unknown: 'neutral'
};

const EMPTY: DockerInventory = { engines: [], containers: [], images: [], volumes: [], networks: [] };

/**
 * Quand aucun moteur ne répond : l'agent ne peut pas distinguer « pas de
 * moteur » de « socket refusée », la note dit donc la condition. Même formulation
 * que la vue des journaux, qui bute sur exactement la même porte.
 */
const NO_ENGINE_HINT =
    'Aucun moteur de conteneurs joignable. L’agent les interroge avec « docker » / « podman » : il lui faut ' +
    'donc accès au démon — service installé en root, ou son utilisateur dans le groupe « docker ».';

/** Une action en cours ou terminée, telle que l'écran la suit. */
interface OpState {
    action: DockerAction;
    lines: string[];
    done: boolean;
    ok?: boolean;
    error?: string;
}

/** Série glissante par conteneur, alimentée par le relevé de stats. */
type SeriesMap = Map<string, { cpu: { t: number; v: number }[]; mem: { t: number; v: number }[] }>;

function newOpId(): string {
    return crypto.randomUUID();
}

/** `actionable` : faux quand la machine refuse les actions Docker (`[policy]`), l'inventaire restant lisible. */
export function DockerPanel({ deviceId, actionable }: { deviceId: string; actionable: boolean }) {
    const [inventory, setInventory] = useState<DockerInventory | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [tab, setTab] = useState<Tab>('containers');
    const [op, setOp] = useState<OpState | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [stats, setStats] = useState<DockerStat[]>([]);
    const [series, setSeries] = useState<SeriesMap>(() => new Map());
    const detectTimer = useRef<number | null>(null);
    /** L'action que CET écran a lancée, pour ne suivre qu'elle. */
    const opIdRef = useRef<string | null>(null);

    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    const requestInventory = useCallback(() => {
        setListError(null);
        if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
        detectTimer.current = window.setTimeout(() => {
            setRefreshing(false);
            setListError('L’agent n’a pas répondu — l’inventaire a peut-être échoué sur l’appareil.');
        }, DETECT_TIMEOUT_MS);
        agent.send('agent.dockerInventory', { deviceId }).catch((e: unknown) => {
            // La raison vient du serveur (agent hors ligne, droits…) : l'afficher
            // telle quelle plutôt qu'un « aucun conteneur » faux.
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
            setRefreshing(false);
            setListError(e instanceof Error ? e.message : 'Inventaire impossible.');
        });
    }, [deviceId]);

    useEffect(() => {
        // Changer d'appareil sans démonter ne doit pas laisser l'inventaire du
        // précédent.
        setInventory(null);
        setStats([]);
        setOp(null);
        setExpanded(null);
        setSeries(new Map());
        opIdRef.current = null;

        const offs = [
            onServerEvent(DEVICE_DOCKER_INVENTORY_EVENT, deviceDockerInventoryPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
                setInventory(d.inventory);
                setListError(null);
                setRefreshing(false);
                // Le serveur joint l'action déjà en cours : le verrou est visible
                // quand on (r)ouvre la fenêtre en cours de route.
                if (d.running && opIdRef.current === null) opIdRef.current = d.running;
            }),
            onServerEvent(DEVICE_DOCKER_STATS_EVENT, deviceDockerStatsPushSchema, (d) => {
                if (d.deviceId !== deviceId) return;
                setStats(d.stats);
                const now = Date.now();
                setSeries((prev) => {
                    const next = new Map(prev);
                    for (const s of d.stats) {
                        const entry = next.get(s.id) ?? { cpu: [], mem: [] };
                        next.set(s.id, {
                            cpu: [...entry.cpu, { t: now, v: s.cpuPercent ?? 0 }].slice(-SERIES_POINTS),
                            mem: [...entry.mem, { t: now, v: s.memUsedBytes ?? 0 }].slice(-SERIES_POINTS)
                        });
                    }
                    return next;
                });
            }),
            onServerEvent(DEVICE_DOCKER_PROGRESS_EVENT, deviceDockerProgressPushSchema, (d) => {
                if (d.deviceId !== deviceId || d.opId !== opIdRef.current) return;
                setOp((prev) =>
                    prev ? { ...prev, lines: [...prev.lines, d.line].slice(-MAX_LOG_LINES), done: false } : prev
                );
            }),
            onServerEvent(DEVICE_DOCKER_DONE_EVENT, deviceDockerDonePushSchema, (d) => {
                if (d.deviceId !== deviceId || d.opId !== opIdRef.current) return;
                opIdRef.current = null;
                setOp((prev) =>
                    prev
                        ? { ...prev, done: true, ok: d.ok, error: d.error }
                        : { action: d.action, lines: [], done: true, ok: d.ok, error: d.error }
                );
                // L'état de la machine a changé : le relire plutôt que le deviner.
                requestInventory();
            })
        ];
        setRefreshing(true);
        requestInventory();
        return () => {
            for (const off of offs) off();
            if (detectTimer.current !== null) window.clearTimeout(detectTimer.current);
        };
    }, [deviceId, requestInventory]);

    // Relevé de stats tant que le panneau est ouvert. Rien n'est stocké côté
    // serveur : la série ne vit que dans cet onglet.
    useEffect(() => {
        let stop = false;
        const poll = () => {
            if (stop) return;
            agent.send('agent.dockerStats', { deviceId }).catch(() => {
                // Un relevé perdu (agent parti, droit retiré) ne doit pas vider
                // l'écran : le suivant reprendra, ou l'inventaire dira pourquoi.
            });
        };
        poll();
        const timer = window.setInterval(poll, STATS_INTERVAL_MS);
        return () => {
            stop = true;
            window.clearInterval(timer);
        };
    }, [deviceId]);

    const statById = useMemo(() => new Map(stats.map((s) => [s.id, s])), [stats]);
    const inv = inventory ?? EMPTY;
    const reachable = inv.engines.filter((e) => e.reachable);
    const busy = (op !== null && !op.done) || !actionable;

    const run = useCallback(
        (engine: ContainerEngine, action: DockerAction, target: string | null) => {
            const opId = newOpId();
            opIdRef.current = opId;
            setOp({ action, lines: [], done: false });
            agent.send('agent.dockerAction', { deviceId, opId, engine, action, target }).catch((e: unknown) => {
                opIdRef.current = null;
                setOp({
                    action,
                    lines: [],
                    done: true,
                    ok: false,
                    error: e instanceof Error ? e.message : 'Action impossible.'
                });
            });
        },
        [deviceId]
    );

    /** Une action qui détruit passe par une confirmation, jamais par un simple clic. */
    const askThenRun = useCallback(
        (title: string, description: string, engine: ContainerEngine, action: DockerAction, target: string | null) => {
            setConfirm({
                title,
                description,
                confirmLabel: 'Confirmer',
                tone: 'danger',
                onConfirm: () => {
                    setConfirm(null);
                    run(engine, action, target);
                }
            });
        },
        [run]
    );

    const seriesFor = (id: string): { cpu: Series[]; mem: Series[] } => {
        const entry = series.get(id);
        return {
            cpu: [{ points: entry?.cpu ?? [], color: 'var(--accent)', label: 'CPU' }],
            mem: [{ points: entry?.mem ?? [], color: 'var(--warning)', label: 'Mémoire' }]
        };
    };

    return (
        <div className={styles.dockerPanel}>
            <div className={styles.dockerHead}>
                <SegmentedControl options={TABS} value={tab} onChange={setTab} />
                <div className={styles.dockerHeadRight}>
                    {reachable.length > 0 && (
                        <span className={styles.dockerEngines}>
                            {reachable.map((e) => `${e.engine}${e.version ? ` ${e.version}` : ''}`).join(' · ')}
                        </span>
                    )}
                    <Button
                        variant='ghost'
                        icon='refresh'
                        disabled={refreshing}
                        onClick={() => {
                            setRefreshing(true);
                            requestInventory();
                        }}
                        title='Relire l’inventaire'
                    >
                        Actualiser
                    </Button>
                </div>
            </div>

            {listError && <p className={styles.dockerError}>{listError}</p>}
            {!actionable && (
                <p className={styles.dockerHint}>
                    Cette machine refuse les actions sur ses conteneurs (politique locale de l’agent) : l’inventaire
                    reste lisible.
                </p>
            )}

            {inventory === null && !listError ? (
                <p className={styles.waitingMsg}>Inventaire en cours…</p>
            ) : reachable.length === 0 ? (
                <p className={styles.dockerHint}>
                    {NO_ENGINE_HINT}
                    {inv.engines
                        .filter((e) => !e.reachable && e.error)
                        .map((e) => (
                            <span key={e.engine} className={styles.dockerEngineError}>
                                {e.engine} : {e.error}
                            </span>
                        ))}
                </p>
            ) : (
                <>
                    {op && (
                        <div
                            className={`${styles.dockerOp} ${op.done && op.ok === false ? styles.dockerOpFailed : ''}`}
                        >
                            <span className={styles.dockerOpTitle}>
                                <span
                                    className={`icon ${op.done ? (op.ok ? 'icon-check-circle' : 'icon-x-circle') : `icon-spinner ${styles.spinning}`}`}
                                />
                                {op.action}
                                {op.done && (op.ok ? ' — terminé' : ` — échec : ${op.error ?? 'raison inconnue'}`)}
                            </span>
                            {op.lines.length > 0 && <pre className={styles.dockerOpLog}>{op.lines.join('\n')}</pre>}
                        </div>
                    )}

                    {tab === 'containers' && (
                        <ContainersTable
                            containers={inv.containers}
                            statById={statById}
                            expanded={expanded}
                            onExpand={setExpanded}
                            seriesFor={seriesFor}
                            busy={busy}
                            onRun={run}
                            onAsk={askThenRun}
                        />
                    )}

                    {tab === 'images' && (
                        <Table
                            head={['Image', 'Taille', 'Créée', '']}
                            empty='Aucune image.'
                            rows={inv.images.map((i) => ({
                                key: `${i.engine}:${i.id}`,
                                cells: [
                                    <span key='ref' className={styles.dockerName} title={i.id}>
                                        {i.reference}
                                        {i.dangling && <span className={styles.dockerTag}>orpheline</span>}
                                    </span>,
                                    i.size,
                                    i.createdAt,
                                    <div key='act' className={styles.dockerRowActions}>
                                        <ActionButton
                                            icon='cloud'
                                            title='Télécharger la dernière version de cette image'
                                            disabled={busy || i.dangling}
                                            onClick={() => run(i.engine, 'pull', i.reference)}
                                        />
                                        <ActionButton
                                            icon='trash'
                                            danger
                                            title='Supprimer cette image'
                                            disabled={busy}
                                            onClick={() =>
                                                askThenRun(
                                                    'Supprimer cette image ?',
                                                    `« ${i.reference} » sera supprimée de l’appareil. Les conteneurs qui l’utilisent devront la retélécharger.`,
                                                    i.engine,
                                                    'removeImage',
                                                    i.id
                                                )
                                            }
                                        />
                                    </div>
                                ]
                            }))}
                        />
                    )}

                    {tab === 'volumes' && (
                        <Table
                            head={['Volume', 'Pilote', 'Point de montage', '']}
                            empty='Aucun volume.'
                            rows={inv.volumes.map((v) => ({
                                key: `${v.engine}:${v.name}`,
                                cells: [
                                    <span key='name' className={styles.dockerName}>
                                        {v.name}
                                    </span>,
                                    v.driver,
                                    <span key='mount' className={styles.dockerPath}>
                                        {v.mountpoint}
                                    </span>,
                                    <div key='act' className={styles.dockerRowActions}>
                                        <ActionButton
                                            icon='trash'
                                            danger
                                            title='Supprimer ce volume'
                                            disabled={busy}
                                            onClick={() =>
                                                askThenRun(
                                                    'Supprimer ce volume ?',
                                                    `Les données de « ${v.name} » seront perdues, définitivement.`,
                                                    v.engine,
                                                    'removeVolume',
                                                    v.name
                                                )
                                            }
                                        />
                                    </div>
                                ]
                            }))}
                        />
                    )}

                    {tab === 'networks' && (
                        <Table
                            head={['Réseau', 'Pilote', 'Portée', '']}
                            empty='Aucun réseau.'
                            rows={inv.networks.map((n) => ({
                                key: `${n.engine}:${n.id}`,
                                cells: [
                                    <span key='name' className={styles.dockerName}>
                                        {n.name}
                                    </span>,
                                    n.driver,
                                    n.scope,
                                    <div key='act' className={styles.dockerRowActions}>
                                        <ActionButton
                                            icon='trash'
                                            danger
                                            title='Supprimer ce réseau'
                                            disabled={busy}
                                            onClick={() =>
                                                askThenRun(
                                                    'Supprimer ce réseau ?',
                                                    `« ${n.name} » sera supprimé. Les conteneurs qui y sont attachés perdront cette connexion.`,
                                                    n.engine,
                                                    'removeNetwork',
                                                    n.id
                                                )
                                            }
                                        />
                                    </div>
                                ]
                            }))}
                        />
                    )}

                    <PruneBar engines={reachable.map((e) => e.engine)} busy={busy} onAsk={askThenRun} tab={tab} />
                </>
            )}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

/** Une table simple : le module n'a pas de composant générique, chaque écran écrit la sienne. */
function Table({ head, rows, empty }: { head: string[]; rows: { key: string; cells: ReactNode[] }[]; empty: string }) {
    if (rows.length === 0) return <p className={styles.waitingMsg}>{empty}</p>;
    return (
        <div className={styles.dockerTableWrap}>
            <table className={styles.dockerTable}>
                <thead>
                    <tr>
                        {head.map((h, i) => (
                            <th key={i}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.key}>
                            {r.cells.map((c, i) => (
                                <td key={i}>{c}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ActionButton({
    icon,
    title,
    onClick,
    disabled,
    danger
}: {
    icon: string;
    title: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <button
            type='button'
            className={`${styles.dockerAction} ${danger ? styles.dockerActionDanger : ''}`}
            title={title}
            aria-label={title}
            disabled={disabled}
            onClick={onClick}
        >
            <span className={`icon icon-${icon}`} />
        </button>
    );
}

function ContainersTable({
    containers,
    statById,
    expanded,
    onExpand,
    seriesFor,
    busy,
    onRun,
    onAsk
}: {
    containers: DockerContainer[];
    statById: Map<string, DockerStat>;
    expanded: string | null;
    onExpand: (id: string | null) => void;
    seriesFor: (id: string) => { cpu: Series[]; mem: Series[] };
    busy: boolean;
    onRun: (engine: ContainerEngine, action: DockerAction, target: string | null) => void;
    onAsk: (
        title: string,
        description: string,
        engine: ContainerEngine,
        action: DockerAction,
        target: string | null
    ) => void;
}) {
    if (containers.length === 0) return <p className={styles.waitingMsg}>Aucun conteneur.</p>;
    return (
        <div className={styles.dockerTableWrap}>
            <table className={styles.dockerTable}>
                <thead>
                    <tr>
                        <th>Conteneur</th>
                        <th>État</th>
                        <th>CPU</th>
                        <th>Mémoire</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {containers.map((c) => {
                        const stat = statById.get(c.id);
                        const running = c.state === 'running';
                        const open = expanded === c.id;
                        const compose = c.composeProject !== null && c.composeService !== null;
                        return (
                            <Fragment key={c.id}>
                                <tr>
                                    <td>
                                        <button
                                            type='button'
                                            className={styles.dockerName}
                                            onClick={() => onExpand(open ? null : c.id)}
                                            title={`${c.image}${c.ports ? ` · ${c.ports}` : ''}`}
                                        >
                                            <span
                                                className={`icon icon-arrow-left ${open ? styles.dockerCaretOpen : styles.dockerCaret}`}
                                            />
                                            {c.name || c.id.slice(0, 12)}
                                        </button>
                                        <span className={styles.dockerSub}>{c.image}</span>
                                    </td>
                                    <td>
                                        <StatusBadge tone={STATE_TONES[c.state]} dot>
                                            {STATE_LABELS[c.state]}
                                        </StatusBadge>
                                    </td>
                                    <td className={styles.dockerNum}>
                                        {stat?.cpuPercent != null ? `${stat.cpuPercent.toFixed(1)} %` : '—'}
                                    </td>
                                    <td className={styles.dockerNum}>
                                        {stat?.memUsedBytes != null ? formatBytesFr(stat.memUsedBytes) : '—'}
                                    </td>
                                    <td>
                                        <div className={styles.dockerRowActions}>
                                            {running ? (
                                                <>
                                                    <ActionButton
                                                        icon='pause'
                                                        title='Mettre en pause'
                                                        disabled={busy}
                                                        onClick={() => onRun(c.engine, 'pause', c.id)}
                                                    />
                                                    <ActionButton
                                                        icon='refresh'
                                                        title='Redémarrer'
                                                        disabled={busy}
                                                        onClick={() => onRun(c.engine, 'restart', c.id)}
                                                    />
                                                    <ActionButton
                                                        icon='power'
                                                        title='Arrêter'
                                                        disabled={busy}
                                                        onClick={() => onRun(c.engine, 'stop', c.id)}
                                                    />
                                                </>
                                            ) : c.state === 'paused' ? (
                                                <ActionButton
                                                    icon='play'
                                                    title='Reprendre'
                                                    disabled={busy}
                                                    onClick={() => onRun(c.engine, 'unpause', c.id)}
                                                />
                                            ) : (
                                                <ActionButton
                                                    icon='play'
                                                    title='Démarrer'
                                                    disabled={busy}
                                                    onClick={() => onRun(c.engine, 'start', c.id)}
                                                />
                                            )}
                                            <ActionButton
                                                icon='cloud'
                                                title={
                                                    compose
                                                        ? 'Recréer depuis son image à jour (compose)'
                                                        : 'Recréer : réservé aux conteneurs créés par compose, seul à connaître leur configuration de lancement'
                                                }
                                                disabled={busy || !compose}
                                                onClick={() =>
                                                    onAsk(
                                                        'Recréer ce conteneur ?',
                                                        `« ${c.name} » sera arrêté puis recréé par compose à partir de son image. Une courte interruption est à prévoir.`,
                                                        c.engine,
                                                        'recreate',
                                                        c.id
                                                    )
                                                }
                                            />
                                            <ActionButton
                                                icon='trash'
                                                danger
                                                title='Supprimer ce conteneur'
                                                disabled={busy}
                                                onClick={() =>
                                                    onAsk(
                                                        'Supprimer ce conteneur ?',
                                                        `« ${c.name} » sera arrêté et supprimé. Ce qu’il garde hors volume sera perdu.`,
                                                        c.engine,
                                                        'removeContainer',
                                                        c.id
                                                    )
                                                }
                                            />
                                        </div>
                                    </td>
                                </tr>
                                {open && (
                                    <tr className={styles.dockerDetailRow}>
                                        <td colSpan={5}>
                                            <div className={styles.dockerDetail}>
                                                <dl className={styles.dockerMeta}>
                                                    <dt>Identifiant</dt>
                                                    <dd>{c.id.slice(0, 12)}</dd>
                                                    <dt>Statut</dt>
                                                    <dd>{c.status}</dd>
                                                    <dt>Ports</dt>
                                                    <dd>{c.ports || 'aucun'}</dd>
                                                    <dt>Créé</dt>
                                                    <dd>{c.createdAt}</dd>
                                                    {compose && (
                                                        <>
                                                            <dt>Compose</dt>
                                                            <dd>
                                                                {c.composeProject} · {c.composeService}
                                                            </dd>
                                                        </>
                                                    )}
                                                </dl>
                                                {running && (
                                                    <div className={styles.dockerGraphs}>
                                                        <MiniGraph
                                                            title='CPU'
                                                            series={seriesFor(c.id).cpu}
                                                            yMax={100}
                                                            stat={
                                                                stat?.cpuPercent != null
                                                                    ? `${stat.cpuPercent.toFixed(1)} %`
                                                                    : '—'
                                                            }
                                                            format={(v) => `${v.toFixed(1)} %`}
                                                        />
                                                        <MiniGraph
                                                            title='Mémoire'
                                                            series={seriesFor(c.id).mem}
                                                            stat={
                                                                stat?.memUsedBytes != null
                                                                    ? formatBytesFr(stat.memUsedBytes)
                                                                    : '—'
                                                            }
                                                            format={formatBytesFr}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** Le nettoyage de l'onglet courant : une action par moteur joignable. */
function PruneBar({
    engines,
    busy,
    tab,
    onAsk
}: {
    engines: ContainerEngine[];
    busy: boolean;
    tab: Tab;
    onAsk: (
        title: string,
        description: string,
        engine: ContainerEngine,
        action: DockerAction,
        target: string | null
    ) => void;
}) {
    const spec: Record<Tab, { action: DockerAction; label: string; warning: string }> = {
        containers: {
            action: 'pruneContainers',
            label: 'Nettoyer les conteneurs arrêtés',
            warning: 'Tous les conteneurs arrêtés seront supprimés, avec ce qu’ils gardent hors volume.'
        },
        images: {
            action: 'pruneImages',
            label: 'Nettoyer les images inutilisées',
            warning:
                'Toutes les images qu’aucun conteneur n’utilise seront supprimées. Elles devront être retéléchargées.'
        },
        volumes: {
            action: 'pruneVolumes',
            label: 'Nettoyer les volumes orphelins',
            warning: 'Les données des volumes qu’aucun conteneur n’utilise seront perdues, définitivement.'
        },
        networks: {
            action: 'pruneNetworks',
            label: 'Nettoyer les réseaux inutilisés',
            warning: 'Tous les réseaux qu’aucun conteneur n’utilise seront supprimés.'
        }
    };
    const { action, label, warning } = spec[tab];
    return (
        <div className={styles.dockerPruneBar}>
            {engines.map((engine) => (
                <Button
                    key={engine}
                    variant='ghost'
                    icon='trash'
                    disabled={busy}
                    onClick={() => onAsk(label + ' ?', warning, engine, action, null)}
                >
                    {label}
                    {engines.length > 1 && ` (${engine})`}
                </Button>
            ))}
        </div>
    );
}
