import { GIT_ITEMS_PROVIDER, type GitHomeRepo, type GitItemsProvider } from '@deveye/types/sdk';
import { logFailure, type FeatureService, type FeatureServiceDeps } from '@deveye/types/sdk/server';

import { DEFAULT_EXPOSURE_PREFS, exposurePrefsSchema, type ExposureComponent } from '../../contracts/exposure';
import { inventoryOfFiles, wantsRepoFile } from '../inventory/repoFiles';
import { TOOLS, WATCHED_PRODUCTS, type CveProduct } from '../inventory/tools';
import { matchComponents, type AssetComponents, type MatchCatalogues } from '../matching/match';
import { queryOsv, type OsvCache, type OsvFetch, type VulnResponse } from '../matching/osv';
import type { CveAffectingRow, CveRepo } from '../repo';
import { findingAlert, firstScanAlert, isAlertable, type AlertedFinding, type FirstScan } from './notice';
import { reconcile, type ExistingFinding } from './reconcile';
import type { AssetRow } from './repo';
import { EXPOSURE_PREFS_KEY, openJson, productKey, sealJson, setExposureLink, type AssetSummary } from './shared';

/**
 * La veille de l'espace : un passage toutes les cinq minutes lit les éléments
 * dus (un dépôt dont la tête a bougé), puis réévalue les espaces marqués
 * contre les catalogues. Rien ne part vers l'extérieur pour un élément
 * inchangé, et un espace n'est réévalué que si son inventaire a bougé, si une
 * CVE ingérée touche l'un de ses produits, ou quand le cache d'OSV a vieilli.
 */

const TICK_MS = 5 * 60_000;
/** Ce qu'un passage lit au plus : un espace de vingt dépôts neufs se lit en quelques passages, pas d'un coup. */
const READS_PER_PASS = 6;
/** Un dépôt dont Git ne connaît pas la tête (public, sans jeton) se relit une fois par jour. */
const UNSYNCED_RECHECK_S = 24 * 3600;
const ERROR_RETRY_S = 3600;
/** La fraîcheur du cache d'OSV : au-delà, un avis nouveau a pu paraître. */
const REEVALUATE_S = 6 * 3600;
const RESOLVED_KEPT_S = 30 * 86_400;
const OSV_CACHE_KEPT_S = 7 * 86_400;
const HOUSEKEEPING_S = 3600;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Au-delà, le fil du NVD est réputé en retard et le catalogue ne garantit plus rien. */
const NVD_STALE_AFTER_S = 24 * 3600;

export interface ExposureEngine extends FeatureService {
    /** Des produits viennent de bouger au NVD : les espaces qui les emploient se réévaluent. */
    productsChanged(products: readonly CveProduct[]): Promise<void>;
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

/** Ce dépôt est-il à relire ? */
export function isRepoDue(asset: AssetRow, home: GitHomeRepo, now: number): boolean {
    if (asset.refresh_asked === 1 || asset.status === 'pending') return true;
    if (home.headSha !== null && asset.revision !== home.headSha) return true;
    const since = asset.checked_at ?? 0;
    if (asset.status === 'error') return since < now - ERROR_RETRY_S;
    return home.headSha === null && since < now - UNSYNCED_RECHECK_S;
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

/** Ce qu'une lecture n'a pas pu couvrir, en phrases pour l'inventaire. */
function notesOf(truncated: boolean, skipped: readonly string[]): string[] {
    const notes: string[] = [];
    if (truncated) notes.push('Dépôt trop grand : une partie de ses fichiers n’a pas été lue.');
    if (skipped.length > 0) {
        const shown = skipped.slice(0, 3).join(', ');
        const more = skipped.length > 3 ? ` et ${skipped.length - 3} autres` : '';
        notes.push(`Trop lourds pour être lus : ${shown}${more}.`);
    }
    return notes;
}

export function createExposureEngine(
    deps: FeatureServiceDeps<CveRepo>,
    options: { osvFetch?: OsvFetch } = {}
): ExposureEngine {
    const osvCache = osvCacheOf(deps.repo);
    const dirty = new Set<number>();
    const evaluatedAt = new Map<number, number>();
    const notices = new Map<number, string[]>();
    let lastHousekeeping = 0;
    let halt = new AbortController();
    let loop: Promise<void> | null = null;
    let pending = false;

    const catalogues = (rowsOf: Map<string, readonly CveAffectingRow[]>): MatchCatalogues => ({
        osv: (list) => queryOsv(list, halt.signal, { cache: osvCache, fetchImpl: options.osvFetch }),
        async nvd(vendor, product) {
            const key = `${vendor}:${product}`;
            if (!rowsOf.has(key)) rowsOf.set(key, await deps.repo.affecting(vendor, product));
            return rowsOf.get(key) ?? [];
        },
        async nvdStale(products) {
            const watched = new Map((await deps.repo.listWatched()).map((w) => [`${w.vendor}:${w.product}`, w]));
            const filling = [
                ...new Set(
                    products
                        .filter((p) => watched.get(`${p.vendor}:${p.product}`)?.backfilled_at == null)
                        .map((p) => p.product)
                )
            ];
            if (filling.length > 0) return `Le catalogue du NVD rattrape encore l’historique de ${filling.join(', ')}.`;
            const ingestedAt = await deps.repo.getState('ingestedAt');
            if (ingestedAt === null || nowSeconds() - ingestedAt > NVD_STALE_AFTER_S) {
                return 'Le catalogue du NVD n’a pas été mis à jour depuis plus d’un jour.';
            }
            return null;
        }
    });

    async function readRepo(git: GitItemsProvider, asset: AssetRow, home: GitHomeRepo): Promise<boolean> {
        const ws = asset.workspace_id;
        const repoId = Number(asset.ref);
        const cipher = deps.cipherFor(ws);
        const now = nowSeconds();
        const result = await git.readFiles(repoId, ws, {
            ref: home.headSha,
            // Une relecture demandée relit tout, même un arbre inchangé : c'est
            // le geste qui suit une mise à jour des lecteurs.
            knownTree: asset.refresh_asked === 1 ? null : asset.digest,
            wants: wantsRepoFile,
            maxFiles: MAX_FILES,
            maxFileBytes: MAX_FILE_BYTES
        });
        if (result === null) {
            await deps.repo.deleteAsset(asset.id);
            return true;
        }
        if (result.status === 'unchanged') {
            await deps.repo.saveCheck(asset.id, home.headSha, now);
            return false;
        }
        if (result.status === 'error') {
            logFailure(
                deps.logger,
                result.userSide,
                { workspaceId: ws, repoId, err: result.error },
                'cve: dépôt illisible'
            );
            await deps.repo.saveError(asset.id, await cipher.encrypt(result.error), now);
            return false;
        }
        const label = (await git.describe(repoId, ws))?.label ?? `Dépôt ${repoId}`;
        const inventory = inventoryOfFiles(result.files);
        const summary: AssetSummary = {
            label,
            formats: inventory.formats,
            notes: notesOf(result.truncated, result.skipped),
            componentCount: inventory.components.length
        };
        await deps.repo.saveScan(asset.id, {
            revision: home.headSha,
            digest: result.tree,
            summaryEnc: await sealJson(cipher, summary),
            inventoryEnc: await sealJson(cipher, inventory.components),
            keys: keysOf(inventory.components),
            at: now
        });
        return true;
    }

    /** Les dépôts de Git, rapprochés des éléments suivis ; les dus sont lus, dans la limite du passage. */
    async function collectGit(workspaceIds: readonly number[], budget: { reads: number }): Promise<void> {
        const git = deps.providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
        if (!git) return;
        const now = nowSeconds();
        const homes = await git.listHome(workspaceIds);
        const due: { asset: AssetRow; home: GitHomeRepo }[] = [];
        for (const ws of workspaceIds) {
            const repos = new Map(homes.filter((h) => h.workspaceId === ws).map((h) => [String(h.id), h]));
            let assets = (await deps.repo.listAssets(ws)).filter((a) => a.source === 'git');
            const known = new Set(assets.map((a) => a.ref));
            let changed = false;
            for (const ref of repos.keys()) {
                if (known.has(ref)) continue;
                await deps.repo.insertAsset(ws, 'git', ref, now);
                changed = true;
            }
            for (const a of assets) {
                if (repos.has(a.ref)) continue;
                await deps.repo.deleteAsset(a.id);
                dirty.add(ws);
                changed = true;
            }
            if (changed) {
                assets = (await deps.repo.listAssets(ws)).filter((a) => a.source === 'git');
                deps.live.changed(ws, ['cveExposure']);
            }
            for (const asset of assets) {
                const home = repos.get(asset.ref);
                if (!home || home.paused || asset.excluded === 1) continue;
                if (isRepoDue(asset, home, now)) due.push({ asset, home });
            }
        }
        // Ce qu'un membre a demandé d'abord, puis le jamais lu, puis le plus ancien.
        due.sort(
            (a, b) =>
                b.asset.refresh_asked - a.asset.refresh_asked ||
                Number(b.asset.status === 'pending') - Number(a.asset.status === 'pending') ||
                (a.asset.checked_at ?? 0) - (b.asset.checked_at ?? 0)
        );
        for (const { asset, home } of due) {
            if (budget.reads <= 0 || halt.signal.aborted) return;
            budget.reads--;
            try {
                if (await readRepo(git, asset, home)) dirty.add(asset.workspace_id);
            } catch (e) {
                deps.logger.error({ err: e, assetId: asset.id }, 'cve: lecture d’un dépôt en échec');
            }
            deps.live.changed(asset.workspace_id, ['cveExposure']);
        }
    }

    /** L'inventaire de l'espace confronté aux catalogues, et les constats rapprochés. */
    async function evaluate(ws: number, rowsOf: Map<string, readonly CveAffectingRow[]>): Promise<void> {
        const cipher = deps.cipherFor(ws);
        const now = nowSeconds();
        const assets = (await deps.repo.listAssets(ws)).filter((a) => a.excluded === 0 && a.inventory_enc !== null);
        const inputs: AssetComponents[] = [];
        for (const a of assets) {
            inputs.push({
                assetId: a.id,
                components: await openJson<ExposureComponent[]>(cipher, a.inventory_enc, [])
            });
        }
        const result = await matchComponents(inputs, catalogues(rowsOf));

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
            const finding = { ...op.draft, reopened: op.type === 'update' };
            if (op.type === 'insert' || op.reopened) alerted.push(finding);
            if (op.type === 'insert' || op.state === 'open') open.push(finding);
        }
        await announce(ws, assets, alerted, open);
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
        assets: readonly AssetRow[],
        alerted: readonly AlertedFinding[],
        open: readonly AlertedFinding[]
    ): Promise<void> {
        const prefs =
            (await deps.storeFor(ws).getJson(EXPOSURE_PREFS_KEY, exposurePrefsSchema)) ?? DEFAULT_EXPOSURE_PREFS;
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
        await collectGit(workspaceIds, { reads: READS_PER_PASS });
        for (const ws of workspaceIds) {
            if ((evaluatedAt.get(ws) ?? 0) < now - REEVALUATE_S) dirty.add(ws);
        }
        const rowsOf = new Map<string, readonly CveAffectingRow[]>();
        for (const ws of workspaceIds) {
            if (!dirty.has(ws) || halt.signal.aborted) continue;
            dirty.delete(ws);
            try {
                await evaluate(ws, rowsOf);
            } catch (e) {
                deps.logger.error({ err: e, workspaceId: ws }, 'cve: évaluation de l’exposition en échec');
            }
        }
        if (now - lastHousekeeping > HOUSEKEEPING_S) {
            lastHousekeeping = now;
            await deps.repo.pruneOsvCache(now - OSV_CACHE_KEPT_S);
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
