import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AUDIENCE_CLIENT_PROVIDER,
    DATABASE_CLIENT_PROVIDER,
    DEPLOY_CLIENT_PROVIDER,
    GIT_CLIENT_PROVIDER,
    UPTIME_CLIENT_PROVIDER
} from '@deveye/types/sdk';
import type { SdkTileSummary } from '@deveye/types/sdk/client';
import {
    Button,
    humanizeError,
    moduleClientProvider,
    useDragReorder,
    useResourceVersion,
    useWorkspacePermissions
} from 'deveye-sdk-client';

import { api, relativeAgo } from '../api';
import type { ProjectTabId } from '../tabs';
import {
    DUE_SOON_DAYS,
    KPI_STALE_SECONDS,
    type DashboardTile,
    type Project,
    type ProjectCard,
    type ProjectCardDep,
    type ProjectColumn,
    type ProjectMilestone
} from '../../contracts/domain';
import {
    arrangeTiles,
    dashboardCatalogue,
    type ArrangedTile,
    type DashboardLinks,
    type TileFeature
} from './catalogue';
import { KpiDialog } from './KpiDialog';
import { TaskTileBody } from './TaskTiles';
import { taskStats } from './taskStats';
import { Tile } from './Tile';
import styles from '../style.module.css';

/**
 * La vue d'ensemble d'un projet : ce qu'il faut savoir d'un coup d'œil, sans
 * ouvrir un onglet.
 *
 * Les tuiles de tâches ne coûtent rien : tout se calcule de ce que la fiche
 * tient déjà. Les autres demandent un résumé par module, jamais par élément
 * (`summarize` prend la liste), et rien n'est demandé à un module absent, sans
 * le droit, ou dont aucune tuile n'est visible.
 */

/** La famille, son jeton de contrat, et le libellé de son absence. */
const FEATURES: { id: TileFeature; token: string; missing: string }[] = [
    { id: 'deploy', token: DEPLOY_CLIENT_PROVIDER, missing: 'Le module Déploiements n’est pas installé.' },
    { id: 'uptime', token: UPTIME_CLIENT_PROVIDER, missing: 'Le module Uptime n’est pas installé.' },
    { id: 'audience', token: AUDIENCE_CLIENT_PROVIDER, missing: 'Le module Audience n’est pas installé.' },
    { id: 'database', token: DATABASE_CLIENT_PROVIDER, missing: 'Le module Bases de données n’est pas installé.' },
    { id: 'git', token: GIT_CLIENT_PROVIDER, missing: 'Le module Git n’est pas installé.' }
];

/** Ce que l'hôte attend d'un contrat client, réduit au strict nécessaire. */
interface Summarizer {
    summarize(ids: readonly number[]): Promise<readonly SdkTileSummary[]>;
}

const EMPTY_LINKS: DashboardLinks = { git: [], database: [], audience: [], deploy: [], uptime: [] };

function formatAgo(at: number | null): string {
    return at === null ? 'jamais mesuré' : `mesuré ${relativeAgo(at)}`;
}

interface OverviewProps {
    project: Project;
    columns: readonly ProjectColumn[];
    cards: readonly ProjectCard[];
    milestones: readonly ProjectMilestone[];
    deps: readonly ProjectCardDep[];
    meUserId: number;
    canWrite: boolean;
    onOpenCard: (card: ProjectCard) => void;
    onOpenTab: (tab: ProjectTabId) => void;
}

export function Overview({
    project,
    columns,
    cards,
    milestones,
    deps,
    meUserId,
    canWrite,
    onOpenCard,
    onOpenTab
}: OverviewProps) {
    const permissions = useWorkspacePermissions();
    const boardVersion = useResourceVersion('projects.board');

    const [tiles, setTiles] = useState<DashboardTile[]>([]);
    const [links, setLinks] = useState<DashboardLinks>(EMPTY_LINKS);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** `feature → résumé par identifiant` ; absent = pas encore demandé. */
    const [summaries, setSummaries] = useState<Record<string, Map<number, SdkTileSummary>>>({});
    const [kpiDialog, setKpiDialog] = useState<{ editing: DashboardTile | null } | null>(null);
    const dragging = useRef(false);

    const load = useCallback(async () => {
        try {
            const res = await api.send('projects.dashboard', { projectId: project.id });
            setTiles(res.tiles);
            setLinks(res.links);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger la vue d’ensemble.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id]);

    useEffect(() => {
        if (dragging.current) return;
        void load();
    }, [load, boardVersion]);

    const catalogue = useMemo(() => dashboardCatalogue(project, links), [project, links]);
    const arranged = useMemo(() => arrangeTiles(catalogue, tiles), [catalogue, tiles]);
    const stats = useMemo(
        () => taskStats(columns, cards, milestones, deps, meUserId, Math.floor(Date.now() / 1000)),
        [columns, cards, milestones, deps, meUserId]
    );

    /**
     * Un projet sans tâche ni jalon : six tuiles de zéros n'apprendraient rien, un
     * seul bloc les remplace. Elles gardent leur rang, `persist` travaillant sur
     * `arranged` ; seul ce qui se dessine est filtré, et le glissé avec, qui ne
     * connaît que les boîtes rendues.
     */
    const barren = stats.total === 0 && milestones.length === 0;
    const drawn = arranged.filter((t) => !(barren && t.spec.kind === 'tasks'));
    const visible = drawn.filter((t) => !t.hidden);
    const hidden = drawn.filter((t) => t.hidden);

    /*
     * Les droits en une chaîne, et non l'objet de `useWorkspacePermissions` :
     * celui-ci est neuf à chaque rendu, et en dépendance d'effet il relancerait
     * les résumés sans fin, chaque réponse provoquant le rendu suivant.
     */
    const readable = FEATURES.map((f) => (permissions.canFeature(f.id) ? '1' : '0')).join('');

    /*
     * Un résumé par module, et seulement pour ce qui se voit : une tuile
     * masquée ne charge rien, un module absent ou fermé par le rôle n'est pas
     * sollicité, et un refus n'est pas une erreur à afficher.
     */
    useEffect(() => {
        for (const { id, token } of FEATURES) {
            const shown = arranged.flatMap((t) =>
                !t.hidden && t.spec.kind === 'item' && t.spec.feature === id ? [t.spec.itemId] : []
            );
            if (shown.length === 0) continue;
            const provider = moduleClientProvider<Summarizer>(token);
            if (!provider || !permissions.canFeature(id)) continue;
            void provider
                .summarize(shown)
                .then((rows) => setSummaries((prev) => ({ ...prev, [id]: new Map(rows.map((r) => [r.itemId, r])) })))
                .catch(() => {
                    /* un module qui ne répond pas laisse ses tuiles en attente */
                });
        }
        // `permissions` est volontairement absent des dépendances : `readable`
        // en porte ce qui compte, sous une identité stable.
    }, [arranged, readable, boardVersion]);

    /** L'ordre complet, masquées comprises, à leur rang mémorisé. */
    const persist = useCallback(
        async (next: ArrangedTile[]) => {
            setBusy(true);
            try {
                const res = await api.send('projects.dashboardArrange', {
                    projectId: project.id,
                    tiles: next.map((t) => ({ key: t.spec.key, hidden: t.hidden }))
                });
                setTiles(res.tiles);
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'L’agencement n’a pas pu être enregistré.'));
                void load();
            } finally {
                setBusy(false);
            }
        },
        [project.id, load]
    );

    /*
     * `useDragReorder` mesure des boîtes du DOM : il ne connaît que les tuiles
     * rendues. L'ordre envoyé les recompose avec les masquées, qui gardent leur
     * rang ; sans quoi masquer puis glisser les enverrait toutes à la fin.
     */
    const drag = useDragReorder<HTMLDivElement, HTMLDivElement>({
        ids: visible.map((t) => t.spec.key),
        rowSelector: '[data-dash-tile]',
        layout: 'grid',
        onDragStateChange: (active) => {
            dragging.current = active;
        },
        onReorder: (keys) => {
            const byKey = new Map(arranged.map((t) => [t.spec.key, t]));
            const reordered = (keys as string[]).flatMap((key) => byKey.get(key) ?? []);
            const kept = new Set(reordered.map((t) => t.spec.key));
            void persist([...reordered, ...arranged.filter((t) => !kept.has(t.spec.key))]);
        }
    });

    const setHidden = (key: string, value: boolean) =>
        void persist(arranged.map((t) => (t.spec.key === key ? { ...t, hidden: value } : t)));

    const runKpis = (keys: string[]) => {
        setBusy(true);
        void api
            .send('projects.dashboardKpiRun', { projectId: project.id, tileKeys: keys })
            .then(() => load())
            .catch((e: unknown) => setError(humanizeError(e, 'La mesure a échoué.')))
            .finally(() => setBusy(false));
    };

    const databaseNames = useMemo(() => {
        const byId = summaries.database;
        return links.database.map((id) => ({ id, name: byId?.get(id)?.title ?? `Base #${id}` }));
    }, [links.database, summaries.database]);

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    const now = Math.floor(Date.now() / 1000);

    const renderTile = (entry: ArrangedTile) => {
        const { spec } = entry;
        const common = {
            tileKey: spec.key,
            canWrite,
            dragging: drag.draggingId === spec.key,
            onGripPointerDown: canWrite ? (e: React.PointerEvent) => drag.onGripPointerDown(e, spec.key) : undefined,
            onHide: canWrite ? () => setHidden(spec.key, true) : undefined
        };

        if (spec.kind === 'tasks') {
            const next = stats.nextMilestone;
            const metrics =
                spec.key === 'tasks.progress'
                    ? [
                          {
                              key: 'percent',
                              label: 'terminé',
                              value: `${stats.percentDone} %`,
                              tone: 'accent' as const
                          },
                          { key: 'done', label: 'terminées', value: `${stats.done} / ${stats.total}` }
                      ]
                    : spec.key === 'tasks.due'
                      ? [
                            {
                                key: 'overdue',
                                label: 'dépassées',
                                value: String(stats.overdue),
                                tone: stats.overdue > 0 ? ('bad' as const) : ('neutral' as const)
                            },
                            {
                                key: 'soon',
                                label: `dans ${DUE_SOON_DAYS} jours`,
                                value: String(stats.dueSoon),
                                tone: stats.dueSoon > 0 ? ('warn' as const) : ('neutral' as const)
                            },
                            { key: 'undated', label: 'sans date', value: String(stats.undated) }
                        ]
                      : spec.key === 'tasks.milestone' && next !== null
                        ? [
                              {
                                  key: 'days',
                                  label: next.name,
                                  value: `J-${Math.max(0, Math.ceil((next.dueDate - now) / 86400))}`
                              }
                          ]
                        : [];
            return (
                <Tile
                    key={spec.key}
                    {...common}
                    title={spec.title}
                    size={spec.size}
                    metrics={metrics}
                    unavailable={
                        spec.key === 'tasks.milestone' && stats.lateMilestones > 0
                            ? `${stats.lateMilestones} jalon(s) ont laissé passer leur date.`
                            : null
                    }
                >
                    <TaskTileBody
                        tileKey={spec.key}
                        stats={stats}
                        now={now}
                        onOpenCard={onOpenCard}
                        onOpenTab={onOpenTab}
                    />
                </Tile>
            );
        }

        if (spec.kind === 'item') {
            const feature = FEATURES.find((f) => f.id === spec.feature);
            const provider = feature ? moduleClientProvider<Summarizer>(feature.token) : undefined;
            const summary = summaries[spec.feature]?.get(spec.itemId);
            const unavailable = !provider
                ? (feature?.missing ?? null)
                : !permissions.canFeature(spec.feature)
                  ? 'Votre rôle n’ouvre pas cette fonctionnalité.'
                  : (summary?.unavailable ?? null);
            return (
                <Tile
                    key={spec.key}
                    {...common}
                    title={summary?.title ?? `#${spec.itemId}`}
                    metrics={summary?.metrics ?? []}
                    unavailable={unavailable}
                    note={summary === undefined && unavailable === null ? 'Chargement…' : null}
                />
            );
        }

        const stored = entry.tile;
        const kpi = stored?.kpi ?? null;
        if (kpi === null) return null;
        const linked = links.database.includes(kpi.databaseId);
        const stale = kpi.lastCheckAt === null || now - kpi.lastCheckAt > KPI_STALE_SECONDS;
        return (
            <Tile
                key={spec.key}
                {...common}
                title={kpi.title}
                metrics={
                    kpi.lastValue === null
                        ? []
                        : [
                              {
                                  key: 'value',
                                  label: kpi.unit || 'valeur',
                                  value: kpi.lastValue.toLocaleString('fr-FR'),
                                  tone: firing(kpi.lastValue, kpi.comparator, kpi.threshold) ? 'warn' : 'accent'
                              }
                          ]
                }
                stale={stale}
                unavailable={
                    !linked
                        ? 'Sa base n’est plus reliée à ce projet.'
                        : (kpi.lastError ?? (kpi.lastValue === null ? 'Jamais mesuré.' : null))
                }
                note={linked && kpi.lastError === null ? formatAgo(kpi.lastCheckAt) : null}
                actions={
                    <>
                        {linked && (
                            <button
                                type='button'
                                className={styles.dashTileBtn}
                                title='Remesurer'
                                aria-label={`Remesurer « ${kpi.title} »`}
                                disabled={busy}
                                onClick={() => runKpis([spec.key])}
                            >
                                <span className='icon icon-refresh' />
                            </button>
                        )}
                        <button
                            type='button'
                            className={styles.dashTileBtn}
                            title='Régler cet indicateur'
                            aria-label={`Régler « ${kpi.title} »`}
                            onClick={() => setKpiDialog({ editing: stored })}
                        >
                            <span className='icon icon-settings' />
                        </button>
                    </>
                }
            />
        );
    };

    return (
        <div className={styles.dashboard}>
            {error && <p className={styles.error}>{error}</p>}

            {barren && (
                <section className={styles.dashStart}>
                    <p className={styles.dashStartTitle}>Ce projet n’a pas encore de tâche</p>
                    <p className={styles.dashTileNote}>
                        La vue d’ensemble se remplit toute seule dès la première : avancement, échéances, charge de
                        chacun.
                    </p>
                    <Button icon='projects' onClick={() => onOpenTab('board')}>
                        Ouvrir le Tableau
                    </Button>
                </section>
            )}

            <div ref={drag.listRef} className={styles.dashGrid}>
                {visible.map(renderTile)}
                <div ref={drag.barRef} className={styles.dashBar} aria-hidden='true' />
            </div>

            {hidden.length > 0 && (
                <div className={styles.dashHidden}>
                    <span className={styles.hint}>Masquées :</span>
                    {hidden.map((t) => (
                        <button
                            key={t.spec.key}
                            type='button'
                            className={styles.dashHiddenBtn}
                            disabled={!canWrite || busy}
                            onClick={() => setHidden(t.spec.key, false)}
                        >
                            <span className='icon icon-eye-open' />
                            {titleOf(t, summaries)}
                        </button>
                    ))}
                </div>
            )}

            {/* Un indicateur mesure une base reliée : sans base, le geste
                n'aurait nulle part où aller. */}
            {canWrite && !project.foreign && project.securityTier === 'open' && links.database.length > 0 && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setKpiDialog({ editing: null })}>
                        Ajouter un indicateur
                    </Button>
                </div>
            )}

            <KpiDialog
                open={kpiDialog !== null}
                projectId={project.id}
                editing={kpiDialog?.editing ?? null}
                databases={databaseNames}
                onClose={() => setKpiDialog(null)}
                onSaved={(next) => {
                    setKpiDialog(null);
                    setTiles(next);
                }}
            />
        </div>
    );
}

/** Le seuil est-il franchi ? Sans comparateur, rien ne se teinte. */
function firing(value: number, comparator: string | null, threshold: number | null): boolean {
    if (comparator === null || threshold === null) return false;
    if (comparator === 'gt') return value > threshold;
    if (comparator === 'gte') return value >= threshold;
    if (comparator === 'lt') return value < threshold;
    if (comparator === 'lte') return value <= threshold;
    if (comparator === 'eq') return value === threshold;
    return value !== threshold;
}

/** Le nom d'une tuile masquée : celui qu'elle porterait si elle se dessinait. */
function titleOf(entry: ArrangedTile, summaries: Record<string, Map<number, SdkTileSummary>>): string {
    if (entry.spec.kind === 'tasks') return entry.spec.title;
    if (entry.spec.kind === 'kpi') return entry.tile?.kpi?.title ?? 'Indicateur';
    return summaries[entry.spec.feature]?.get(entry.spec.itemId)?.title ?? `#${entry.spec.itemId}`;
}

export default Overview;
