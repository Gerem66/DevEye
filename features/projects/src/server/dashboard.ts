import { randomBytes } from 'node:crypto';

import {
    projectDashboard,
    projectDashboardArrange,
    projectDashboardKpiRemove,
    projectDashboardKpiRun,
    projectDashboardKpiSave,
    projectDashboardKpiTest
} from '../contracts/commands';
import {
    DASHBOARD_MAX_KPIS,
    dashboardKpiDraftSchema,
    type DashboardKpiDraft,
    type DashboardMeasure,
    type DashboardTile,
    type DashboardTileRow
} from '../contracts/domain';
import { DATABASE_MEASURE_PROVIDER, type DatabaseMeasureProvider } from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { assertAtHome, LINKS, loadProject, projectCipher, type Ctx } from './_shared';

/**
 * La vue d'ensemble d'un projet : l'agencement de ses tuiles, et les indicateurs
 * sur mesure qu'il mesure contre une base reliée.
 *
 * Deux règles portent tout le fichier. L'agencement est en clair et ne se
 * déchiffre pas : un projet confidentiel verrouillé doit pouvoir arranger ses
 * tuiles de tâches. Et un indicateur ne vise qu'une base **reliée au projet** :
 * sans cette garde, cet onglet serait une console SQL universelle pour qui tient
 * `projects: write`.
 */

/** La requête d'un indicateur, telle qu'elle est scellée. */
function parseKpi(plain: string): DashboardKpiDraft | null {
    try {
        const parsed = dashboardKpiDraftSchema.safeParse(JSON.parse(plain));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Une ligne rendue au client. Un corps illisible (session scellée, blob abîmé)
 * garde la tuile : son rang et son masquage sont en clair et valent toujours.
 */
async function toTile(cipher: SdkCipher, row: DashboardTileRow): Promise<DashboardTile> {
    const tile: DashboardTile = {
        key: row.tile_key,
        sortOrder: row.sort_order,
        hidden: row.hidden === 1,
        kpi: null
    };
    if (row.content === '' || row.database_id === null) return tile;
    const plain = await cipher.tryDecrypt(row.content);
    const draft = plain === null ? null : parseKpi(plain);
    if (!draft) return tile;
    return {
        ...tile,
        kpi: {
            ...draft,
            databaseId: row.database_id,
            lastValue: row.last_number === null ? null : Number(row.last_number),
            lastError: row.last_error,
            lastCheckAt: row.last_check_at
        }
    };
}

async function tilesOf(ctx: Ctx, projectId: number, workspaceId: number, cipher: SdkCipher): Promise<DashboardTile[]> {
    const rows = await ctx.repo.dashboard.list(projectId, workspaceId);
    return Promise.all(rows.map((row) => toTile(cipher, row)));
}

/** Les bases que ce projet relie : la seule surface qu'un indicateur peut mesurer. */
async function linkedDatabaseIds(ctx: Ctx, projectId: number, workspaceId: number): Promise<number[]> {
    return ctx.repo.links.listDatabaseIds(projectId, workspaceId);
}

async function assertMeasurable(ctx: Ctx, projectId: number, workspaceId: number, databaseId: number): Promise<void> {
    if (!(await linkedDatabaseIds(ctx, projectId, workspaceId)).includes(databaseId)) {
        throw new FeatureError('validation', 'Cette base n’est pas reliée à ce projet.');
    }
}

function measureProvider(ctx: Ctx): DatabaseMeasureProvider {
    const provider = ctx.providers.get<DatabaseMeasureProvider>(DATABASE_MEASURE_PROVIDER);
    if (!provider) throw new FeatureError('validation', 'Le module Bases de données n’est pas installé.');
    return provider;
}

export const projectDashboardFeature = defineSdkFeature({
    ...projectDashboard,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const home = project.workspace_id;
        const [tiles, git, database, audience, deploy, uptime, hosting] = await Promise.all([
            projectCipher(ctx, project).then((cipher) => tilesOf(ctx, input.projectId, home, cipher)),
            ctx.repo.links.listRepoIds(input.projectId, home),
            ctx.repo.links.listDatabaseIds(input.projectId, home),
            ctx.repo.links.listSiteIds(input.projectId, home),
            ctx.repo.links.listDeployTargetIds(input.projectId, home),
            ctx.repo.links.listServiceIds(input.projectId, home),
            ctx.repo.links.listPackIds(input.projectId, home)
        ]);
        return {
            tiles,
            counts: {
                git: git.length,
                database: database.length,
                audience: audience.length,
                deploy: deploy.length,
                uptime: uptime.length,
                'x-hosting': hosting.length
            },
            links: { git, database, audience, deploy, uptime, 'x-hosting': hosting }
        };
    }
});

export const projectDashboardArrangeFeature = defineSdkFeature({
    ...projectDashboardArrange,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        // Pas d'`assertAtHome` : l'agencement ne désigne aucun objet d'un autre
        // espace, il n'écrit que des rangs et des booléens. Les deux espaces
        // partagent donc une seule vue, ce qui est la règle voulue.
        const project = await loadProject(ctx, input.projectId, 'write');
        const home = project.workspace_id;
        const seen = new Set<string>();
        for (const tile of input.tiles) {
            if (seen.has(tile.key)) throw new FeatureError('validation', 'Deux tuiles portent la même clé.');
            seen.add(tile.key);
        }
        await ctx.repo.dashboard.arrange(input.projectId, home, input.tiles);
        return { tiles: await tilesOf(ctx, input.projectId, home, await projectCipher(ctx, project)) };
    }
});

export const projectDashboardKpiSaveFeature = defineSdkFeature({
    ...projectDashboardKpiSave,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        // La base visée est un objet de l'espace d'origine : une fenêtre ne la
        // voit pas et lui substituerait la sienne.
        assertAtHome(ctx, project, 'poser un indicateur');
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne relie aucune base : il ne peut pas en mesurer une.'
            );
        }
        const home = project.workspace_id;
        await assertMeasurable(ctx, input.projectId, home, input.databaseId);
        // Le formulaire refuse tout de suite ce que la mesure refuserait plus tard.
        assertReadOnlyDraft(input.kpi.sql);

        const cipher = await projectCipher(ctx, project);
        const existing = await ctx.repo.dashboard.list(input.projectId, home);
        if (input.tileKey === undefined && existing.filter((r) => r.content !== '').length >= DASHBOARD_MAX_KPIS) {
            throw new FeatureError('validation', `Un projet ne porte pas plus de ${DASHBOARD_MAX_KPIS} indicateurs.`);
        }
        const tileKey = input.tileKey ?? `kpi:${randomBytes(8).toString('hex')}`;
        if (input.tileKey !== undefined && !existing.some((r) => r.tile_key === tileKey && r.content !== '')) {
            throw new FeatureError('not_found', 'Cet indicateur n’existe plus.');
        }
        await ctx.repo.dashboard.upsertKpi({
            projectId: input.projectId,
            workspaceId: home,
            tileKey,
            databaseId: input.databaseId,
            content: await cipher.encrypt(JSON.stringify(input.kpi))
        });
        return { tiles: await tilesOf(ctx, input.projectId, home, cipher) };
    }
});

export const projectDashboardKpiRemoveFeature = defineSdkFeature({
    ...projectDashboardKpiRemove,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        const home = project.workspace_id;
        if (!(await ctx.repo.dashboard.removeKpi(input.projectId, home, input.tileKey))) {
            throw new FeatureError('not_found', 'Cet indicateur n’existe plus.');
        }
        return { tiles: await tilesOf(ctx, input.projectId, home, await projectCipher(ctx, project)) };
    }
});

export const projectDashboardKpiRunFeature = defineSdkFeature({
    ...projectDashboardKpiRun,
    mutates: true,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'mesurer un indicateur');
        const home = project.workspace_id;
        const cipher = await projectCipher(ctx, project);
        const wanted = input.tileKeys === undefined ? null : new Set(input.tileKeys);
        const linked = new Set(await linkedDatabaseIds(ctx, input.projectId, home));

        const rows = (await ctx.repo.dashboard.list(input.projectId, home)).filter(
            (r) => r.content !== '' && r.database_id !== null && (wanted === null || wanted.has(r.tile_key))
        );

        // Groupées par base : le tunnel d'une base se paie une fois pour toutes
        // ses requêtes, et une session par tuile coûterait bien plus que les
        // chiffres ne valent.
        const byDatabase = new Map<number, { key: string; sql: string }[]>();
        const at = Math.floor(Date.now() / 1000);
        const measures: DashboardMeasure[] = [];
        for (const row of rows) {
            const databaseId = row.database_id as number;
            const plain = await cipher.tryDecrypt(row.content);
            const draft = plain === null ? null : parseKpi(plain);
            if (!draft) {
                measures.push({ key: row.tile_key, value: null, error: 'Cet indicateur est illisible.', at });
                continue;
            }
            if (!linked.has(databaseId)) {
                measures.push({
                    key: row.tile_key,
                    value: null,
                    error: 'Cette base n’est plus reliée à ce projet.',
                    at
                });
                continue;
            }
            const list = byDatabase.get(databaseId) ?? [];
            list.push({ key: row.tile_key, sql: draft.sql });
            byDatabase.set(databaseId, list);
        }

        if (byDatabase.size > 0) {
            const provider = measureProvider(ctx);
            for (const [databaseId, queries] of byDatabase) {
                const outcomes = await provider.measure(
                    databaseId,
                    home,
                    queries.map((q) => q.sql)
                );
                for (const [index, query] of queries.entries()) {
                    const outcome = outcomes?.[index] ?? {
                        value: null,
                        error: 'Cette base n’existe plus dans cet espace.'
                    };
                    await ctx.repo.dashboard.recordMeasure(input.projectId, query.key, { ...outcome, at });
                    measures.push({ key: query.key, value: outcome.value, error: outcome.error, at });
                }
            }
            ctx.audit({
                action: 'projects.dashboardKpiRun',
                description: `Projet #${input.projectId} : ${measures.length} indicateur(s) mesuré(s)`
            });
        }
        return { measures };
    }
});

export const projectDashboardKpiTestFeature = defineSdkFeature({
    ...projectDashboardKpiTest,
    access: LINKS,
    handler: async (ctx: Ctx, input) => {
        const project = await loadProject(ctx, input.projectId, 'write');
        assertAtHome(ctx, project, 'essayer un indicateur');
        await assertMeasurable(ctx, input.projectId, project.workspace_id, input.databaseId);
        assertReadOnlyDraft(input.sql);
        const outcome = (await measureProvider(ctx).measure(input.databaseId, project.workspace_id, [input.sql]))?.[0];
        return outcome ?? { value: null, error: 'Cette base n’existe plus dans cet espace.' };
    }
});

/**
 * La même règle que le moteur du module Bases de données, redite ici pour que le
 * formulaire refuse tout de suite : Projets ne peut pas importer son moteur, et
 * la mesure refera le contrôle de toute façon.
 */
function assertReadOnlyDraft(sql: string): void {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (trimmed === '') throw new FeatureError('validation', 'La requête est vide.');
    if (trimmed.includes(';')) {
        throw new FeatureError('validation', 'Une seule instruction : le point-virgule n’est pas accepté au milieu.');
    }
    if (!/^(select|with|show|explain)\b/i.test(trimmed)) {
        throw new FeatureError(
            'validation',
            'Seules les requêtes de lecture sont acceptées (SELECT, WITH, SHOW, EXPLAIN).'
        );
    }
}

export const projectDashboardFeatures = [
    projectDashboardFeature,
    projectDashboardArrangeFeature,
    projectDashboardKpiSaveFeature,
    projectDashboardKpiRemoveFeature,
    projectDashboardKpiRunFeature,
    projectDashboardKpiTestFeature
];
