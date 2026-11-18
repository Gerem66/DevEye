import type { DeviceReport } from '@deveye/types';
import { logFailure, type FeatureService, type FeatureServiceDeps } from '@deveye/types/sdk/server';

import {
    DEFAULT_EXPOSURE_PREFS,
    exposurePrefsSchema,
    type ExposureComponent,
    type ExposurePrefs
} from '../../contracts/exposure';
import { TOOLS, WATCHED_PRODUCTS, type CveProduct } from '../inventory/tools';
import { matchComponents, type AssetComponents, type MatchCatalogues } from '../matching/match';
import { fetchDump } from '../matching/eol';
import { queryOsv, type OsvCache, type OsvFetch, type VulnResponse } from '../matching/osv';
import { nvdStaleReason } from '../matching/nvdCatalogue';
import { fetchPackage, metaKey, RegistryUnavailable, type PackageMeta } from '../matching/registry';
import type { CveAffectingRow, CveRepo } from '../repo';
import { findingAlert, firstScanAlert, isAlertable, type AlertedFinding, type FirstScan } from './notice';
import { loadEolIndex } from './annotate';
import { reconcile, type ExistingFinding } from './reconcile';
import type { AssetRow } from './repo';
import { EXPOSURE_PREFS_KEY, openJson, productKey, sealJson, setExposureLink, type AssetSummary } from './shared';
import {
    databaseSource,
    deploySource,
    deviceSource,
    gitSource,
    osRevision,
    type Source,
    type SourceItem
} from './sources';

/**
 * La veille de l'espace : un passage toutes les cinq minutes lit les éléments
 * dus (un dépôt dont la tête a bougé), puis réévalue les espaces marqués
 * contre les catalogues. Rien ne part vers l'extérieur pour un élément
 * inchangé, et un espace n'est réévalué que si son inventaire a bougé, si une
 * CVE ingérée touche l'un de ses produits, ou quand le cache d'OSV a vieilli.
 */

const TICK_MS = 5 * 60_000;
/**
 * Un premier échec se retente une minute après, au passage suivant : un agent
 * qui redémarre ou un relais pas encore revenu. Un échec qui se répète attend
 * une heure.
 */
const FIRST_RETRY_S = 60;
const ERROR_RETRY_S = 3600;
/** La fraîcheur du cache d'OSV : au-delà, un avis nouveau a pu paraître. */
const REEVALUATE_S = 6 * 3600;
const RESOLVED_KEPT_S = 30 * 86_400;
const OSV_CACHE_KEPT_S = 7 * 86_400;
const HOUSEKEEPING_S = 3600;
/** Le catalogue des fins de vie se relit une fois par jour ; un échec se retente une heure après. */
const EOL_REFRESH_S = 24 * 3600;
const EOL_RETRY_S = 3600;
/** Ce que deps.dev dit d'un paquet reste bon un jour. */
const REGISTRY_TTL_S = 24 * 3600;
const REGISTRY_KEPT_S = 7 * 86_400;
/** Les paquets qu'une évaluation demande au plus à deps.dev : le reste attend le passage suivant. */
const REGISTRY_PER_EVALUATION = 100;

export interface ExposureEngine extends FeatureService {
    /** Des produits viennent de bouger au NVD : les espaces qui les emploient se réévaluent. */
    productsChanged(products: readonly CveProduct[]): Promise<void>;
    /** Un appareil vient de se rapporter : s'il a changé de système, il se relit sans attendre. */
    deviceReported(deviceId: string, report: DeviceReport): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Le cache commun d'OSV, adossé aux deux tables du module. */
export function osvCacheOf(repo: CveRepo): OsvCache {
    return {
        async queries(keys, freshSince) {
            const rows = await repo.osvQueries(keys, freshSince);
            return new Map(rows.map((r) => [r.pkg_key, JSON.parse(r.vuln_ids) as string[]]));
        },
        saveQueries: (entries, at) =>
            repo.saveOsvQueries(
                entries.map((e) => ({ key: e.key, vulnIds: JSON.stringify(e.vulnIds) })),
                at
            ),
        async vulns(ids, freshSince) {
            const rows = await repo.osvVulns(ids, freshSince);
            return new Map(rows.map((r) => [r.id, JSON.parse(r.body) as VulnResponse]));
        },
        saveVulns: (entries, at) =>
            repo.saveOsvVulns(
                entries.map((e) => ({ id: e.id, body: JSON.stringify(e.body) })),
                at
            )
    };
}

/** Les empreintes des produits d'un inventaire : ce qu'une CVE ingérée cherche. */
function keysOf(components: readonly ExposureComponent[]): string[] {
    const keys = new Set<string>();
    for (const c of components) {
        if (c.kind !== 'product') continue;
        for (const p of TOOLS[c.ecosystem]?.products ?? []) keys.add(productKey(p));
    }
    return [...keys];
}

export function createExposureEngine(
    deps: FeatureServiceDeps<CveRepo>,
    options: { osvFetch?: OsvFetch; eolFetch?: typeof fetch; registryFetch?: typeof fetch } = {}
): ExposureEngine {
    const osvCache = osvCacheOf(deps.repo);
    const dirty = new Set<number>();
    const evaluatedAt = new Map<number, number>();
    const notices = new Map<number, string[]>();
    /** En mémoire : un redémarrage redonne à chacun son essai rapide. */
    const failedTwice = new Set<number>();
    let lastHousekeeping = 0;
    let lastEolAttempt = 0;
    /** Une fois par jour, le dump d'endoflife.date ; ensuite, chaque espace se réévalue. */
    async function refreshEol(workspaceIds: readonly number[], now: number): Promise<void> {
        const fetchedAt = (await deps.repo.getState('eolFetchedAt')) ?? 0;
        if (now - fetchedAt < EOL_REFRESH_S || now - lastEolAttempt < EOL_RETRY_S) return;
        lastEolAttempt = now;
        try {
            const products = await fetchDump(options.eolFetch);
            await deps.repo.replaceEolProducts(
                products.map((p) => ({ product: p.name, body: JSON.stringify(p) })),
                now
            );
            await deps.repo.setState('eolFetchedAt', now);
            for (const ws of workspaceIds) dirty.add(ws);
        } catch (e) {
            deps.logger.warn({ err: (e as Error).message }, 'cve: catalogue des fins de vie non relu');
        }
    }
    let halt = new AbortController();
    let loop: Promise<void> | null = null;
    let pending = false;

    const catalogues = (ws: number, rowsOf: Map<string, readonly CveAffectingRow[]>): MatchCatalogues => ({
        eol: () => loadEolIndex(deps.repo),
        async registry(packages) {
            const now = nowSeconds();
            const key = (p: { system: string; name: string }): string => `${p.system}|${p.name}`;
            const cached = new Map(
                (
                    await deps.repo.pkgMeta(
                        packages.map((p) => metaKey(p.system, p.name)),
                        now - REGISTRY_TTL_S
                    )
                ).map((r) => [r.pkg_key, r.body])
            );
            const metas = new Map<string, PackageMeta | null>();
            const fresh: { key: string; body: string }[] = [];
            let reason: string | null = null;
            let budget = REGISTRY_PER_EVALUATION;
            for (const p of packages) {
                const body = cached.get(metaKey(p.system, p.name));
                if (body !== undefined) {
                    metas.set(key(p), JSON.parse(body) as PackageMeta | null);
                    continue;
                }
                if (reason !== null) continue;
                if (budget-- <= 0) {
                    // Le reste au passage suivant, sans attendre six heures.
                    reason = 'Les registres de paquets se lisent par lots : le reste suit dans quelques minutes.';
                    dirty.add(ws);
                    continue;
                }
                try {
                    const meta = await fetchPackage(p.system, p.name, options.registryFetch);
                    metas.set(key(p), meta);
                    fresh.push({ key: metaKey(p.system, p.name), body: JSON.stringify(meta) });
                } catch (e) {
                    if (!(e instanceof RegistryUnavailable)) throw e;
                    reason = `${e.message} Les constats de paquets d’avant restent.`;
                }
            }
            if (fresh.length > 0) await deps.repo.savePkgMeta(fresh, now);
            return { metas, reason };
        },
        osv: (list) => queryOsv(list, halt.signal, { cache: osvCache, fetchImpl: options.osvFetch }),
        async nvd(vendor, product) {
            const key = `${vendor}:${product}`;
            if (!rowsOf.has(key)) rowsOf.set(key, await deps.repo.affecting(vendor, product));
            return rowsOf.get(key) ?? [];
        },
        nvdStale: (products) => nvdStaleReason(deps.repo, products, nowSeconds())
    });

    const sources: readonly Source[] = [
        gitSource(deps),
        deviceSource(deps),
        databaseSource(deps),
        deploySource(deps)
    ] as readonly Source[];

    /** Ce qu'une lecture a rendu, écrit ; `true` quand l'inventaire a changé. */
    async function apply(source: Source, asset: AssetRow, item: SourceItem): Promise<boolean> {
        const ws = asset.workspace_id;
        const cipher = deps.cipherFor(ws);
        const now = nowSeconds();
        const outcome = await source.read(asset, item);
        if (outcome.kind !== 'error') failedTwice.delete(asset.id);
        if (outcome.kind === 'gone') {
            await deps.repo.deleteAsset(asset.id);
            return true;
        }
        if (outcome.kind === 'unchanged') {
            await deps.repo.saveCheck(asset.id, outcome.revision, now);
            return false;
        }
        if (outcome.kind === 'error') {
            logFailure(
                deps.logger,
                outcome.userSide,
                { workspaceId: ws, source: source.id, ref: asset.ref, err: outcome.error },
                'cve: élément illisible'
            );
            if (asset.status === 'error') failedTwice.add(asset.id);
            await deps.repo.saveError(asset.id, await cipher.encrypt(outcome.error), now);
            return false;
        }
        const summary: AssetSummary = {
            label: outcome.label,
            formats: outcome.formats,
            notes: outcome.notes,
            componentCount: outcome.components.length
        };
        await deps.repo.saveScan(asset.id, {
            revision: outcome.revision,
            digest: outcome.digest,
            summaryEnc: await sealJson(cipher, summary),
            inventoryEnc: await sealJson(cipher, outcome.components),
            keys: keysOf(outcome.components),
            at: now
        });
        return true;
    }

    /**
     * Les éléments d'une source, rapprochés des éléments suivis ; les dus sont
     * lus, dans la limite que la source s'accorde par passage. Une source que
     * l'espace a coupée n'est ni rapprochée ni lue.
     */
    async function collect(source: Source, workspaceIds: readonly number[]): Promise<void> {
        const items = await source.list(workspaceIds);
        if (items === null) return;
        const now = nowSeconds();
        const due: { asset: AssetRow; item: SourceItem }[] = [];
        for (const ws of workspaceIds) {
            const listed = new Map(items.filter((i) => i.workspaceId === ws).map((i) => [i.ref, i]));
            let assets = (await deps.repo.listAssets(ws)).filter((a) => a.source === source.id);
            const known = new Set(assets.map((a) => a.ref));
            let changed = false;
            for (const ref of listed.keys()) {
                if (known.has(ref)) continue;
                await deps.repo.insertAsset(ws, source.id, ref, now);
                changed = true;
            }
            for (const a of assets) {
                if (listed.has(a.ref)) continue;
                await deps.repo.deleteAsset(a.id);
                dirty.add(ws);
                changed = true;
            }
            if (changed) {
                assets = (await deps.repo.listAssets(ws)).filter((a) => a.source === source.id);
                deps.live.changed(ws, ['cveExposure']);
            }
            for (const asset of assets) {
                const item = listed.get(asset.ref);
                if (!item || item.paused || asset.excluded === 1) continue;
                const commonDue =
                    asset.refresh_asked === 1 ||
                    asset.status === 'pending' ||
                    (asset.status === 'error' &&
                        (asset.checked_at ?? 0) < now - (failedTwice.has(asset.id) ? ERROR_RETRY_S : FIRST_RETRY_S));
                if (commonDue || (asset.status !== 'error' && source.isDue(asset, item, now))) {
                    due.push({ asset, item });
                }
            }
        }
        // Ce qu'un membre a demandé d'abord, puis le jamais lu, puis le plus ancien.
        due.sort(
            (a, b) =>
                b.asset.refresh_asked - a.asset.refresh_asked ||
                Number(b.asset.status === 'pending') - Number(a.asset.status === 'pending') ||
                (a.asset.checked_at ?? 0) - (b.asset.checked_at ?? 0)
        );
        let reads = source.readsPerPass;
        for (const { asset, item } of due) {
            if (reads <= 0 || halt.signal.aborted) return;
            reads--;
            try {
                if (await apply(source, asset, item)) dirty.add(asset.workspace_id);
            } catch (e) {
                deps.logger.error({ err: e, assetId: asset.id, source: source.id }, 'cve: lecture en échec');
            }
            deps.live.changed(asset.workspace_id, ['cveExposure']);
        }
    }

    /** L'inventaire de l'espace confronté aux catalogues, et les constats rapprochés. */
    async function evaluate(
        ws: number,
        prefs: ExposurePrefs,
        rowsOf: Map<string, readonly CveAffectingRow[]>
    ): Promise<void> {
        const cipher = deps.cipherFor(ws);
        const now = nowSeconds();
        const assets = (await deps.repo.listAssets(ws)).filter(
            (a) =>
                a.excluded === 0 &&
                a.inventory_enc !== null &&
                prefs.sources[a.source as keyof ExposurePrefs['sources']]
        );
        const inputs: AssetComponents[] = [];
        for (const a of assets) {
            inputs.push({
                assetId: a.id,
                components: await openJson<ExposureComponent[]>(cipher, a.inventory_enc, [])
            });
        }
        const result = await matchComponents(inputs, catalogues(ws, rowsOf));

        const linkRows = await deps.repo.linksOf(ws);
        const links = new Map<number, Map<number, boolean>>();
        for (const l of linkRows) {
            const of = links.get(l.finding_id) ?? new Map<number, boolean>();
            of.set(l.asset_id, l.covered === 1);
            links.set(l.finding_id, of);
        }
        const existing: ExistingFinding[] = (await deps.repo.listFindings(ws)).map((f) => ({
            id: f.id,
            kind: f.kind,
            subjectKey: f.subject_key,
            origin: f.origin,
            state: f.state,
            severity: f.severity,
            score: f.score,
            links: links.get(f.id) ?? new Map()
        }));

        let changed = false;
        const alerted: AlertedFinding[] = [];
        /** Ce qui reste ouvert après l'évaluation : ce qu'un premier inventaire récapitule. */
        const open: AlertedFinding[] = [];
        for (const op of reconcile(existing, result.drafts, result.unavailable)) {
            if (op.type === 'resolve') {
                await deps.repo.resolveFinding(op.id, now);
                changed = true;
                continue;
            }
            const write = {
                kind: op.draft.kind,
                origin: op.draft.origin,
                subjectKey: op.draft.subjectKey,
                advisoryId: op.draft.advisoryId,
                severity: op.draft.severity,
                score: op.draft.score,
                contentEnc: await sealJson(cipher, op.draft.content)
            };
            const assetIds = op.draft.content.affected.map((a) => a.assetId);
            if (op.type === 'insert') {
                const id = await deps.repo.insertFinding(ws, write, now);
                await deps.repo.setLinks(id, assetIds, []);
                changed = true;
            } else {
                await deps.repo.updateFinding(op.id, write, op.state, op.reopened, now);
                await deps.repo.setLinks(op.id, assetIds, op.covered);
                changed ||= op.significant;
            }
            const finding = { ...op.draft, reopened: op.type === 'update' && op.reopened };
            // Une fin de vie proche qui devient atteinte se dit une seconde fois.
            const escalated = op.type === 'update' && op.escalated && op.draft.kind === 'eol';
            if (op.type === 'insert' || op.reopened || escalated) alerted.push(finding);
            if (op.type === 'insert' || op.state === 'open') open.push(finding);
        }
        await announce(ws, prefs, assets, alerted, open);
        const before = notices.get(ws) ?? [];
        const after = Object.values(result.unavailable);
        notices.set(ws, after);
        evaluatedAt.set(ws, now);
        if (changed || before.join('\n') !== after.join('\n')) deps.live.changed(ws, ['cveExposure']);
    }

    /**
     * Les alertes de ce que l'évaluation vient d'ouvrir. Un élément lu pour la
     * première fois ne fait qu'un récapitulatif de ce qu'il a d'ouvert, connu
     * ailleurs ou non : ajouter un dépôt ne doit pas faire une alerte par
     * paquet vulnérable. Un constat neuf qui touche aussi un élément déjà
     * annoncé part, lui, en alerte à part entière.
     */
    async function announce(
        ws: number,
        prefs: ExposurePrefs,
        assets: readonly AssetRow[],
        alerted: readonly AlertedFinding[],
        open: readonly AlertedFinding[]
    ): Promise<void> {
        const fresh = new Map(assets.filter((a) => a.announced === 0).map((a) => [a.id, a]));
        const labels = new Map<number, string>();
        const cipher = deps.cipherFor(ws);
        for (const a of assets) {
            labels.set(
                a.id,
                (await openJson<AssetSummary | null>(cipher, a.summary_enc, null))?.label ?? `Élément ${a.id}`
            );
        }
        const labelOf = (id: number): string => labels.get(id) ?? `Élément ${id}`;
        const notify = deps.deveyeFor(ws).notify;
        const send = (alert: Parameters<typeof notify.send>[0]): Promise<void> =>
            notify.send(alert).then(
                () => undefined,
                (e: unknown) => deps.logger.error({ err: e, workspaceId: ws }, 'cve: alerte non livrée')
            );

        for (const f of alerted) {
            if (!isAlertable(f, prefs)) continue;
            const ids = f.content.affected.map((a) => a.assetId);
            if (ids.length > 0 && ids.every((id) => fresh.has(id))) continue;
            await send(findingAlert(f, labelOf));
        }
        const scans = new Map<number, FirstScan>();
        for (const f of open) {
            if (!isAlertable(f, prefs)) continue;
            for (const id of f.content.affected.map((a) => a.assetId)) {
                if (!fresh.has(id)) continue;
                const scan = scans.get(id) ?? { label: labelOf(id), critical: 0, vulns: 0, others: 0 };
                if (f.kind === 'vuln') scan.vulns++;
                else scan.others++;
                if (f.kind === 'vuln' && f.severity === 'critical') scan.critical++;
                scans.set(id, scan);
            }
        }
        if (scans.size > 0) await send(firstScanAlert([...scans.values()]));
        await deps.repo.markAnnounced([...fresh.keys()]);
    }

    async function pass(): Promise<void> {
        const now = nowSeconds();
        const workspaceIds = await deps.listWorkspaceIds();
        const prefs = new Map<number, ExposurePrefs>();
        for (const ws of workspaceIds) {
            prefs.set(
                ws,
                (await deps.storeFor(ws).getJson(EXPOSURE_PREFS_KEY, exposurePrefsSchema)) ?? DEFAULT_EXPOSURE_PREFS
            );
        }
        await refreshEol(workspaceIds, now);
        for (const source of sources) {
            if (halt.signal.aborted) return;
            const enabled = workspaceIds.filter((ws) => prefs.get(ws)?.sources[source.id] !== false);
            try {
                await collect(source, enabled);
            } catch (e) {
                deps.logger.error({ err: e, source: source.id }, 'cve: collecte d’une source en échec');
            }
        }
        for (const ws of workspaceIds) {
            if ((evaluatedAt.get(ws) ?? 0) < now - REEVALUATE_S) dirty.add(ws);
        }
        const rowsOf = new Map<string, readonly CveAffectingRow[]>();
        for (const ws of workspaceIds) {
            if (!dirty.has(ws) || halt.signal.aborted) continue;
            dirty.delete(ws);
            try {
                await evaluate(ws, prefs.get(ws) ?? DEFAULT_EXPOSURE_PREFS, rowsOf);
            } catch (e) {
                deps.logger.error({ err: e, workspaceId: ws }, 'cve: évaluation de l’exposition en échec');
            }
        }
        if (now - lastHousekeeping > HOUSEKEEPING_S) {
            lastHousekeeping = now;
            await deps.repo.pruneOsvCache(now - OSV_CACHE_KEPT_S);
            await deps.repo.prunePkgMeta(now - REGISTRY_KEPT_S);
            await deps.repo.purgeResolved(now - RESOLVED_KEPT_S);
        }
    }

    // Deux chemins mènent à un passage, le cadran et un geste d'un membre :
    // `pending` retient le second plutôt que de le perdre ou de doubler le premier.
    const runGuarded = (): Promise<void> => {
        if (loop) {
            pending = true;
            return loop;
        }
        loop = (async () => {
            try {
                do {
                    pending = false;
                    await pass();
                } while (pending && !halt.signal.aborted);
            } finally {
                loop = null;
            }
        })();
        return loop;
    };
    const wake = (): void => {
        void runGuarded().catch((e: unknown) => deps.logger.error({ err: e }, 'cve: passage de la veille en échec'));
    };

    const ticker = deps.createTicker({ intervalMs: TICK_MS, tick: runGuarded });

    return {
        async deviceReported(deviceId, report) {
            const revision = osRevision({ report });
            let changed = false;
            for (const asset of await deps.repo.findAssetsByRef('device', deviceId)) {
                if (asset.scanned_at === null || asset.revision === revision) continue;
                await deps.repo.askRefresh(asset.id);
                changed = true;
            }
            if (changed) wake();
        },
        async productsChanged(products) {
            const ids = await deps.repo.workspacesWithKeys(products.map(productKey));
            for (const id of ids) dirty.add(id);
            if (ids.length > 0) wake();
        },
        async start() {
            halt = new AbortController();
            // Les produits que la veille sait reconnaître gardent tout leur
            // historique : une version ancienne doit trouver ses CVE anciennes.
            await deps.repo.watch(WATCHED_PRODUCTS, nowSeconds());
            setExposureLink({
                wake,
                markDirty: (ws) => dirty.add(ws),
                noticesOf: (ws) => notices.get(ws) ?? []
            });
            ticker.start();
            wake();
        },
        async stop() {
            halt.abort();
            setExposureLink(null);
            await ticker.stop();
            await loop?.catch(() => undefined);
        }
    };
}
