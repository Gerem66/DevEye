import type { DashboardTile, Project, ProjectLinkCounts } from '../../contracts/domain';

/**
 * Ce que la vue d'ensemble d'un projet peut montrer, et dans quel ordre par
 * défaut. Le catalogue est du code, pas des lignes en base : une tuile ajoutée
 * ici paraît sur tous les projets sans migration, et la table ne porte que ce
 * qui a été arrangé.
 */

/** Les familles dont une tuile résume un élément relié. */
export type TileFeature = 'git' | 'database' | 'audience' | 'deploy' | 'uptime';

export type TileSpec =
    | { kind: 'tasks'; key: string; title: string }
    | { kind: 'item'; key: string; feature: TileFeature; itemId: number }
    | { kind: 'kpi'; key: string };

/** Les identifiants reliés, tels que `projects.dashboard` les rend. */
export type DashboardLinks = Record<TileFeature, number[]>;

/** Les tuiles de tâches, toujours là : elles ne dépendent d'aucun service extérieur. */
const TASK_TILES: TileSpec[] = [
    { kind: 'tasks', key: 'tasks.counts', title: 'Tâches' },
    { kind: 'tasks', key: 'tasks.due', title: 'Échéances' },
    { kind: 'tasks', key: 'tasks.milestone', title: 'Prochain jalon' }
];

/** L'ordre naturel des familles : ce qu'on livre, puis ce que ça donne. */
const FEATURE_ORDER: TileFeature[] = ['deploy', 'uptime', 'audience', 'database', 'git'];

/**
 * Le catalogue d'un projet. Un projet confidentiel ne relie rien, et un projet
 * projeté ne voit pas les éléments de son espace d'origine : dans les deux cas
 * il ne reste que les tâches.
 */
export function dashboardCatalogue(project: Project, links: DashboardLinks): TileSpec[] {
    if (project.securityTier === 'guarded' || project.foreign) return [...TASK_TILES];
    return [
        ...TASK_TILES,
        ...FEATURE_ORDER.flatMap((feature) =>
            links[feature].map((itemId): TileSpec => ({ kind: 'item', key: `${feature}:${itemId}`, feature, itemId }))
        )
    ];
}

/** Combien d'éléments chaque famille relie, pour la barre d'onglets et les états vides. */
export function linkCountsOf(links: DashboardLinks): ProjectLinkCounts {
    return {
        git: links.git.length,
        database: links.database.length,
        audience: links.audience.length,
        deploy: links.deploy.length,
        uptime: links.uptime.length
    };
}

export interface ArrangedTile {
    spec: TileSpec;
    hidden: boolean;
    /** La définition stockée d'un indicateur ; `null` sur une tuile automatique. */
    tile: DashboardTile | null;
}

/**
 * L'ordre affiché : ce que le projet a arrangé d'abord, puis les tuiles du
 * catalogue jamais touchées, à leur rang naturel. Une clé arrangée qui n'est
 * plus au catalogue est ignorée sans être effacée, le module peut revenir.
 */
export function arrangeTiles(catalogue: TileSpec[], stored: readonly DashboardTile[]): ArrangedTile[] {
    const kpis: TileSpec[] = stored.filter((t) => t.kpi !== null).map((t) => ({ kind: 'kpi' as const, key: t.key }));
    const known = new Map<string, TileSpec>([...catalogue, ...kpis].map((spec) => [spec.key, spec]));
    const byKey = new Map(stored.map((t) => [t.key, t]));

    const ranked = [...stored].sort((a, b) => a.sortOrder - b.sortOrder);
    const placed = new Set<string>();
    const out: ArrangedTile[] = [];
    for (const row of ranked) {
        const spec = known.get(row.key);
        if (!spec) continue;
        placed.add(row.key);
        out.push({ spec, hidden: row.hidden, tile: row.kpi === null ? null : row });
    }
    // Jamais arrangées : elles prennent la suite, dans l'ordre du catalogue.
    for (const spec of [...catalogue, ...kpis]) {
        if (placed.has(spec.key)) continue;
        const row = byKey.get(spec.key) ?? null;
        out.push({ spec, hidden: row?.hidden ?? false, tile: row?.kpi ? row : null });
    }
    return out;
}
