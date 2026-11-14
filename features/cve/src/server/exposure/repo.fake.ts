import type { AssetRow, ExposureRepo, FindingLinkRow, FindingRow } from './repo';

/** L'exposition en mémoire, même contrat que le vrai dépôt : ce que les tests du module partagent. */
export interface MemoryExposure extends ExposureRepo {
    assets: AssetRow[];
    findings: FindingRow[];
    links: FindingLinkRow[];
    keys: { asset_id: number; key_hash: string }[];
}

export function memoryExposureRepo(): MemoryExposure {
    const assets: AssetRow[] = [];
    const findings: FindingRow[] = [];
    const links: FindingLinkRow[] = [];
    const keys: { asset_id: number; key_hash: string }[] = [];
    const osvQueries = new Map<string, { vuln_ids: string; at: number }>();
    const osvVulns = new Map<string, { body: string; at: number }>();
    let nextAsset = 1;
    let nextFinding = 1;
    const asset = (id: number): AssetRow | undefined => assets.find((a) => a.id === id);
    const finding = (id: number): FindingRow | undefined => findings.find((f) => f.id === id);
    const dropLinks = (pred: (l: FindingLinkRow) => boolean): void => {
        for (let i = links.length - 1; i >= 0; i--) if (pred(links[i])) links.splice(i, 1);
    };

    return {
        assets,
        findings,
        links,
        keys,
        async listAssets(workspaceId) {
            return assets.filter((a) => a.workspace_id === workspaceId).map((a) => ({ ...a }));
        },
        async findAsset(workspaceId, id) {
            const a = asset(id);
            return a && a.workspace_id === workspaceId ? { ...a } : null;
        },
        async insertAsset(workspaceId, source, ref, at) {
            if (assets.some((a) => a.workspace_id === workspaceId && a.source === source && a.ref === ref)) return;
            assets.push({
                id: nextAsset++,
                workspace_id: workspaceId,
                source,
                ref,
                status: 'pending',
                excluded: 0,
                revision: null,
                digest: null,
                checked_at: null,
                scanned_at: null,
                refresh_asked: 0,
                announced: 0,
                error_enc: null,
                summary_enc: null,
                inventory_enc: null,
                created: at
            });
        },
        async deleteAsset(id) {
            const i = assets.findIndex((a) => a.id === id);
            if (i !== -1) assets.splice(i, 1);
            dropLinks((l) => l.asset_id === id);
            for (let k = keys.length - 1; k >= 0; k--) if (keys[k].asset_id === id) keys.splice(k, 1);
        },
        async saveScan(id, scan) {
            const a = asset(id);
            if (!a) return;
            Object.assign(a, {
                status: 'ok',
                revision: scan.revision,
                digest: scan.digest,
                summary_enc: scan.summaryEnc,
                inventory_enc: scan.inventoryEnc,
                error_enc: null,
                checked_at: scan.at,
                scanned_at: scan.at,
                refresh_asked: 0
            });
            for (let k = keys.length - 1; k >= 0; k--) if (keys[k].asset_id === id) keys.splice(k, 1);
            for (const key of new Set(scan.keys)) keys.push({ asset_id: id, key_hash: key });
        },
        async saveCheck(id, revision, at) {
            const a = asset(id);
            if (!a) return;
            Object.assign(a, {
                revision,
                checked_at: at,
                refresh_asked: 0,
                status: a.scanned_at === null ? a.status : 'ok',
                error_enc: null
            });
        },
        async saveError(id, errorEnc, at) {
            const a = asset(id);
            if (a) Object.assign(a, { status: 'error', error_enc: errorEnc, checked_at: at, refresh_asked: 0 });
        },
        async setExcluded(id, excluded) {
            const a = asset(id);
            if (!a) return;
            a.excluded = excluded ? 1 : 0;
            if (!excluded) a.announced = 0;
        },
        async markAnnounced(ids) {
            for (const id of ids) {
                const a = asset(id);
                if (a) a.announced = 1;
            }
        },
        async askRefresh(id) {
            const a = asset(id);
            if (a) a.refresh_asked = 1;
        },
        async workspacesWithKeys(wanted) {
            const ids = new Set<number>();
            for (const k of keys) {
                if (wanted.includes(k.key_hash)) ids.add(asset(k.asset_id)?.workspace_id ?? -1);
            }
            ids.delete(-1);
            return [...ids];
        },
        async listFindings(workspaceId) {
            return findings.filter((f) => f.workspace_id === workspaceId).map((f) => ({ ...f }));
        },
        async findFinding(workspaceId, id) {
            const f = finding(id);
            return f && f.workspace_id === workspaceId ? { ...f } : null;
        },
        async linksOf(workspaceId) {
            return links.filter((l) => finding(l.finding_id)?.workspace_id === workspaceId).map((l) => ({ ...l }));
        },
        async insertFinding(workspaceId, w, at) {
            const id = nextFinding++;
            findings.push({
                id,
                workspace_id: workspaceId,
                kind: w.kind,
                origin: w.origin,
                subject_key: w.subjectKey,
                advisory_id: w.advisoryId,
                severity: w.severity,
                score: w.score,
                state: 'open',
                first_seen: at,
                last_seen: at,
                resolved_at: null,
                due_at: null,
                notified_stage: null,
                content_enc: w.contentEnc,
                ignored_by: null,
                ignored_at: null,
                reason_enc: null
            });
            return id;
        },
        async updateFinding(id, w, state, reopened, at) {
            const f = finding(id);
            if (!f) return;
            Object.assign(f, {
                origin: w.origin,
                advisory_id: w.advisoryId,
                severity: w.severity,
                score: w.score,
                content_enc: w.contentEnc,
                last_seen: at,
                state,
                resolved_at: null
            });
            if (reopened)
                Object.assign(f, { notified_stage: null, ignored_by: null, ignored_at: null, reason_enc: null });
        },
        async resolveFinding(id, at) {
            const f = finding(id);
            if (f) Object.assign(f, { state: 'resolved', resolved_at: at });
            dropLinks((l) => l.finding_id === id);
        },
        async setLinks(findingId, assetIds, covered) {
            dropLinks((l) => l.finding_id === findingId);
            for (const id of new Set(assetIds)) {
                links.push({ finding_id: findingId, asset_id: id, covered: covered.includes(id) ? 1 : 0 });
            }
        },
        async ignoreFinding(id, userId, reasonEnc, at) {
            const f = finding(id);
            if (f) Object.assign(f, { state: 'ignored', ignored_by: userId, ignored_at: at, reason_enc: reasonEnc });
            for (const l of links) if (l.finding_id === id) l.covered = 1;
        },
        async restoreFinding(id) {
            const f = finding(id);
            if (f) Object.assign(f, { state: 'open', ignored_by: null, ignored_at: null, reason_enc: null });
            for (const l of links) if (l.finding_id === id) l.covered = 0;
        },
        async countOpen(workspaceId, assetIds) {
            const counts = new Map<string, { kind: FindingRow['kind']; severity: FindingRow['severity']; n: number }>();
            for (const f of findings) {
                if (f.workspace_id !== workspaceId || f.state !== 'open') continue;
                if (!links.some((l) => l.finding_id === f.id && assetIds.includes(l.asset_id))) continue;
                const key = `${f.kind}|${f.severity}`;
                const row = counts.get(key) ?? { kind: f.kind, severity: f.severity, n: 0 };
                row.n++;
                counts.set(key, row);
            }
            return [...counts.values()];
        },
        async openByAsset(workspaceId) {
            const counts = new Map<number, number>();
            for (const l of links) {
                const f = finding(l.finding_id);
                if (f?.workspace_id !== workspaceId || f.state !== 'open') continue;
                counts.set(l.asset_id, (counts.get(l.asset_id) ?? 0) + 1);
            }
            return [...counts].map(([asset_id, n]) => ({ asset_id, n }));
        },
        async purgeResolved(before) {
            let removed = 0;
            for (let i = findings.length - 1; i >= 0; i--) {
                const f = findings[i];
                if (f.state === 'resolved' && (f.resolved_at ?? 0) < before) {
                    findings.splice(i, 1);
                    dropLinks((l) => l.finding_id === f.id);
                    removed++;
                }
            }
            return removed;
        },
        async osvQueries(wanted, freshSince) {
            return wanted.flatMap((key) => {
                const hit = osvQueries.get(key);
                return hit && hit.at >= freshSince ? [{ pkg_key: key, vuln_ids: hit.vuln_ids }] : [];
            });
        },
        async saveOsvQueries(entries, at) {
            for (const e of entries) osvQueries.set(e.key, { vuln_ids: e.vulnIds, at });
        },
        async osvVulns(ids, freshSince) {
            return ids.flatMap((id) => {
                const hit = osvVulns.get(id);
                return hit && hit.at >= freshSince ? [{ id, body: hit.body }] : [];
            });
        },
        async saveOsvVulns(entries, at) {
            for (const e of entries) osvVulns.set(e.id, { body: e.body, at });
        },
        async pruneOsvCache(before) {
            for (const [k, v] of osvQueries) if (v.at < before) osvQueries.delete(k);
            for (const [k, v] of osvVulns) if (v.at < before) osvVulns.delete(k);
        },
        async osvCacheSize() {
            return { queries: osvQueries.size, vulns: osvVulns.size };
        }
    };
}
