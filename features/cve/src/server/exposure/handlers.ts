import {
    DATABASE_ITEMS_PROVIDER,
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    PROJECTS_USAGE_PROVIDER,
    type DatabaseItemsProvider,
    type DeployItemsProvider,
    type GitItemsProvider,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import { defineSdkFeature, FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import {
    cveAsset,
    cveAssetExclude,
    cveAssetRefresh,
    cveExposure,
    cveExposureCount,
    cveExposurePrefs,
    cveFindingIgnore,
    cveFindingRestore,
    cveInventory,
    cveSetExposurePrefs
} from '../../contracts/commands';
import {
    DEFAULT_EXPOSURE_PREFS,
    exposurePrefsSchema,
    type ExposureAsset,
    type ExposureComponent,
    type ExposureCounts,
    type ExposureFinding,
    type ExposurePrefs,
    type ExposureSource
} from '../../contracts/exposure';
import type { FindingContent } from '../matching/match';
import { annotate } from './annotate';
import type { CveRepo } from '../repo';
import type { AssetRow, FindingRow } from './repo';
import {
    EXPOSURE_PREFS_KEY,
    exposureNotices,
    markExposureDirty,
    openJson,
    wakeExposure,
    type AssetSummary
} from './shared';

type Ctx = SdkFeatureContext<CveRepo>;

async function prefsOf(ctx: Ctx): Promise<ExposurePrefs> {
    return (await ctx.store.getJson(EXPOSURE_PREFS_KEY, exposurePrefsSchema)) ?? DEFAULT_EXPOSURE_PREFS;
}

/**
 * Les éléments de l'espace que ce membre peut voir chez leur feature. Une
 * source que l'espace a coupée ne montre rien : elle ne compte plus nulle part.
 */
async function visibleAssets(ctx: Ctx, rows: readonly AssetRow[]): Promise<Set<number>> {
    const prefs = await prefsOf(ctx);
    const git = ctx.providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
    const databases = ctx.providers.get<DatabaseItemsProvider>(DATABASE_ITEMS_PROVIDER);
    const deploy = ctx.providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
    let devices: Set<string> | null = null;
    const visible = new Set<number>();
    for (const a of rows) {
        const source = a.source as ExposureSource;
        if (!prefs.sources[source]) continue;
        const id = Number(a.ref);
        let ok = false;
        if (source === 'git') ok = git !== undefined && (await git.authorize(id, ctx.workspaceId, ctx.userId)).ok;
        else if (source === 'database') {
            ok = databases !== undefined && (await databases.authorize(id, ctx.workspaceId, ctx.userId)).ok;
        } else if (source === 'deploy') {
            ok = deploy !== undefined && (await deploy.authorize(id, ctx.workspaceId, ctx.userId)).ok;
        } else {
            // Dans une commande, la liste écarte déjà ce que le membre ne voit pas.
            devices ??= new Set((await ctx.deveye.devices.list()).map((d) => d.id));
            ok = devices.has(a.ref);
        }
        if (ok) visible.add(a.id);
    }
    return visible;
}

/** La feature de Projets qui relie un élément de cette source, quand elle sait le relier. */
const PROJECT_FEATURE: Partial<Record<ExposureSource, string>> = { git: 'git', deploy: 'deploy', database: 'database' };

/** Les projets de chaque élément, pour le filtre de la liste. */
async function projectsOf(
    ctx: Ctx,
    assets: ReadonlyMap<number, ExposureAsset>
): Promise<Map<number, { id: number; title: string }[]>> {
    const projects = ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
    const out = new Map<number, { id: number; title: string }[]>();
    if (!projects) return out;
    for (const asset of assets.values()) {
        const feature = PROJECT_FEATURE[asset.source];
        if (!feature) continue;
        const usage = await projects.usageOf(feature, Number(asset.ref), ctx.workspaceId);
        out.set(
            asset.id,
            usage.map((u) => ({ id: u.projectId, title: u.title }))
        );
    }
    return out;
}

async function toAsset(cipher: SdkCipher, row: AssetRow, openFindings: number): Promise<ExposureAsset> {
    const summary = await openJson<AssetSummary | null>(cipher, row.summary_enc, null);
    return {
        id: row.id,
        source: row.source as ExposureSource,
        ref: row.ref,
        label: summary?.label ?? `Élément ${row.ref}`,
        status: row.status,
        error: row.error_enc === null ? null : await cipher.tryDecrypt(row.error_enc),
        excluded: row.excluded === 1,
        checkedAt: row.checked_at === null ? null : Number(row.checked_at),
        scannedAt: row.scanned_at === null ? null : Number(row.scanned_at),
        formats: summary?.formats ?? [],
        componentCount: summary?.componentCount ?? 0,
        notes: summary?.notes ?? [],
        openFindings
    };
}

const EMPTY_CONTENT: FindingContent = {
    title: 'Constat illisible',
    summary: '',
    subject: { kind: 'package', ecosystem: '', name: '' },
    fixed: [],
    reference: null,
    aliases: [],
    affected: []
};

/** Un constat tel qu'un membre le voit : seulement les éléments qu'il peut voir, `null` s'il n'en reste aucun. */
async function toFinding(
    cipher: SdkCipher,
    row: FindingRow,
    assets: ReadonlyMap<number, ExposureAsset>,
    visible: ReadonlySet<number>,
    projects: ReadonlyMap<number, { id: number; title: string }[]> = new Map()
): Promise<ExposureFinding | null> {
    const content = await openJson<FindingContent>(cipher, row.content_enc, EMPTY_CONTENT);
    const affected = content.affected.flatMap((a) => {
        const asset = assets.get(a.assetId);
        if (!asset || !visible.has(a.assetId)) return [];
        return [
            {
                assetId: a.assetId,
                source: asset.source,
                ref: asset.ref,
                label: asset.label,
                version: a.version,
                path: a.path,
                line: a.line,
                projects: projects.get(a.assetId) ?? []
            }
        ];
    });
    if (affected.length === 0) return null;
    return {
        id: row.id,
        kind: row.kind,
        state: row.state,
        advisoryId: row.advisory_id,
        severity: row.severity,
        score: row.score === null ? null : Number(row.score),
        title: content.title,
        summary: content.summary,
        subject: content.subject,
        fixed: content.fixed,
        reference: content.reference,
        aliases: content.aliases,
        firstSeen: Number(row.first_seen),
        lastSeen: Number(row.last_seen),
        resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
        ignoredAt: row.ignored_at === null ? null : Number(row.ignored_at),
        ignoredBy: row.ignored_by,
        reason: row.reason_enc === null ? null : await cipher.tryDecrypt(row.reason_enc),
        affected
    };
}

/** Les éléments de l'espace, rendus, et ceux que ce membre voit. */
async function assetsOf(ctx: Ctx): Promise<{ assets: Map<number, ExposureAsset>; visible: Set<number> }> {
    const cipher = ctx.cipher();
    const rows = await ctx.repo.listAssets(ctx.workspaceId);
    const visible = await visibleAssets(ctx, rows);
    const open = new Map((await ctx.repo.openByAsset(ctx.workspaceId)).map((r) => [Number(r.asset_id), Number(r.n)]));
    const assets = new Map<number, ExposureAsset>();
    for (const row of rows) {
        if (visible.has(row.id)) assets.set(row.id, await toAsset(cipher, row, open.get(row.id) ?? 0));
    }
    return { assets, visible };
}

async function visibleFinding(ctx: Ctx, id: number): Promise<{ row: FindingRow; finding: ExposureFinding }> {
    const row = await ctx.repo.findFinding(ctx.workspaceId, id);
    const { assets, visible } = await assetsOf(ctx);
    const finding = row ? await toFinding(ctx.cipher(), row, assets, visible) : null;
    if (!row || !finding) throw new FeatureError('not_found', 'Ce constat n’existe plus.');
    return { row, finding };
}

async function visibleAsset(ctx: Ctx, id: number): Promise<AssetRow> {
    const row = await ctx.repo.findAsset(ctx.workspaceId, id);
    if (!row || !(await visibleAssets(ctx, [row])).has(row.id)) {
        throw new FeatureError('not_found', 'Cet élément n’est plus suivi.');
    }
    return row;
}

async function assetView(ctx: Ctx, id: number): Promise<ExposureAsset> {
    const { assets } = await assetsOf(ctx);
    const asset = assets.get(id);
    if (!asset) throw new FeatureError('not_found', 'Cet élément n’est plus suivi.');
    return asset;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const exposureHandlers = [
    defineSdkFeature({
        ...cveExposurePrefs,
        handler: async (ctx: Ctx) => ({
            prefs: (await ctx.store.getJson(EXPOSURE_PREFS_KEY, exposurePrefsSchema)) ?? DEFAULT_EXPOSURE_PREFS
        })
    }),
    defineSdkFeature({
        ...cveSetExposurePrefs,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Chiffrement 'server' par défaut : la veille, sans session, les relit.
            await ctx.store.putJson(EXPOSURE_PREFS_KEY, exposurePrefsSchema, input.prefs);
            // Une source coupée ou rendue se reflète dans les constats sans attendre.
            markExposureDirty(ctx.workspaceId);
            ctx.audit({
                action: 'cve.setExposurePrefs',
                description: 'Réglages de la veille enregistrés',
                metadata: { alerts: input.prefs.alerts, threshold: input.prefs.threshold }
            });
            return { prefs: input.prefs };
        }
    }),
    defineSdkFeature({
        ...cveExposure,
        handler: async (ctx: Ctx, input) => {
            const cipher = ctx.cipher();
            const { assets, visible } = await assetsOf(ctx);
            const projects = await projectsOf(ctx, assets);
            const rows = (await ctx.repo.listFindings(ctx.workspaceId)).filter((r) =>
                input.view === 'resolved' ? r.state === 'resolved' : r.state !== 'resolved'
            );
            const findings: ExposureFinding[] = [];
            for (const row of rows) {
                const finding = await toFinding(cipher, row, assets, visible, projects);
                if (finding) findings.push(finding);
            }
            const scans = [...assets.values()].map((a) => a.scannedAt ?? 0);
            const scannedAt = scans.length > 0 ? Math.max(...scans) : 0;
            return { findings, scannedAt: scannedAt > 0 ? scannedAt : null, notices: exposureNotices(ctx.workspaceId) };
        }
    }),
    defineSdkFeature({
        ...cveExposureCount,
        handler: async (ctx: Ctx) => {
            // Rien ne s'y déchiffre : la carte répond coffre verrouillé.
            const rows = await ctx.repo.listAssets(ctx.workspaceId);
            const visible = await visibleAssets(ctx, rows);
            const counts: ExposureCounts = {
                count: 0,
                critical: 0,
                high: 0,
                eol: 0,
                deprecated: 0,
                outdated: 0,
                scanned: rows.filter((r) => visible.has(r.id) && r.scanned_at !== null && r.excluded === 0).length
            };
            for (const r of await ctx.repo.countOpen(ctx.workspaceId, [...visible])) {
                const n = Number(r.n);
                if (r.kind === 'vuln') {
                    counts.count += n;
                    if (r.severity === 'critical') counts.critical += n;
                    if (r.severity === 'high') counts.high += n;
                } else counts[r.kind] += n;
            }
            return counts;
        }
    }),
    defineSdkFeature({
        ...cveInventory,
        handler: async (ctx: Ctx) => {
            const { assets } = await assetsOf(ctx);
            return { assets: [...assets.values()] };
        }
    }),
    defineSdkFeature({
        ...cveAsset,
        handler: async (ctx: Ctx, input) => {
            const row = await visibleAsset(ctx, input.id);
            const components = await openJson<ExposureComponent[]>(ctx.cipher(), row.inventory_enc, []);
            return { asset: await assetView(ctx, row.id), components: await annotate(ctx.repo, components) };
        }
    }),
    defineSdkFeature({
        ...cveFindingIgnore,
        access: { level: 'write' },
        mutates: ['cveExposure'],
        handler: async (ctx: Ctx, input) => {
            const { row, finding } = await visibleFinding(ctx, input.id);
            if (row.state === 'resolved') throw new FeatureError('conflict', 'Ce constat ne touche plus rien.');
            const reasonEnc = input.reason.length > 0 ? await ctx.cipher().encrypt(input.reason) : null;
            await ctx.repo.ignoreFinding(row.id, ctx.userId, reasonEnc, nowSeconds());
            ctx.audit({
                action: 'cve.findingIgnore',
                description: `Constat ignoré : ${finding.advisoryId ?? finding.title}`,
                metadata: { findingId: row.id, advisoryId: finding.advisoryId }
            });
            return { finding: (await visibleFinding(ctx, row.id)).finding };
        }
    }),
    defineSdkFeature({
        ...cveFindingRestore,
        access: { level: 'write' },
        mutates: ['cveExposure'],
        handler: async (ctx: Ctx, input) => {
            const { row, finding } = await visibleFinding(ctx, input.id);
            if (row.state !== 'ignored') return { finding };
            await ctx.repo.restoreFinding(row.id);
            ctx.audit({
                action: 'cve.findingRestore',
                description: `Constat rétabli : ${finding.advisoryId ?? finding.title}`,
                metadata: { findingId: row.id, advisoryId: finding.advisoryId }
            });
            return { finding: (await visibleFinding(ctx, row.id)).finding };
        }
    }),
    defineSdkFeature({
        ...cveAssetRefresh,
        access: { level: 'write' },
        mutates: ['cveExposure'],
        handler: async (ctx: Ctx, input) => {
            const row = await visibleAsset(ctx, input.id);
            await ctx.repo.askRefresh(row.id);
            wakeExposure();
            return { asset: await assetView(ctx, row.id) };
        }
    }),
    defineSdkFeature({
        ...cveAssetExclude,
        access: { level: 'write' },
        mutates: ['cveExposure'],
        handler: async (ctx: Ctx, input) => {
            const row = await visibleAsset(ctx, input.id);
            await ctx.repo.setExcluded(row.id, input.excluded);
            // Ses constats se rapprochent au passage suivant : un élément exclu
            // ne compte plus nulle part.
            markExposureDirty(ctx.workspaceId);
            ctx.audit({
                action: input.excluded ? 'cve.assetExclude' : 'cve.assetInclude',
                description: `${input.excluded ? 'Élément sorti de la veille' : 'Élément remis dans la veille'} : ${row.source} ${row.ref}`,
                metadata: { assetId: row.id }
            });
            return { asset: await assetView(ctx, row.id) };
        }
    })
];
