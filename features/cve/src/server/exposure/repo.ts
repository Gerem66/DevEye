import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { CveSeverity } from '../../contracts/domain';
import type { AssetStatus, FindingKind, FindingState } from '../../contracts/exposure';

/** Une ligne de `ft_cve_assets`. */
export interface AssetRow {
    id: number;
    workspace_id: number;
    source: string;
    ref: string;
    status: AssetStatus;
    excluded: number;
    revision: string | null;
    digest: string | null;
    checked_at: number | null;
    scanned_at: number | null;
    refresh_asked: number;
    announced: number;
    error_enc: string | null;
    summary_enc: string | null;
    inventory_enc: string | null;
    created: number;
}

/** Une ligne de `ft_cve_findings`. */
export interface FindingRow {
    id: number;
    workspace_id: number;
    kind: FindingKind;
    origin: string;
    subject_key: string;
    advisory_id: string | null;
    severity: CveSeverity;
    score: number | null;
    state: FindingState;
    first_seen: number;
    last_seen: number;
    resolved_at: number | null;
    due_at: number | null;
    notified_stage: string | null;
    content_enc: string;
    ignored_by: number | null;
    ignored_at: number | null;
    reason_enc: string | null;
}

export interface FindingLinkRow {
    finding_id: number;
    asset_id: number;
    covered: number;
}

export interface FindingWrite {
    kind: FindingKind;
    origin: string;
    subjectKey: string;
    advisoryId: string | null;
    severity: CveSeverity;
    score: number | null;
    contentEnc: string;
}

export interface CountRow {
    kind: FindingKind;
    severity: CveSeverity;
    n: number;
}

export interface ExposureRepo {
    listAssets(workspaceId: number): Promise<AssetRow[]>;
    findAsset(workspaceId: number, id: number): Promise<AssetRow | null>;
    insertAsset(workspaceId: number, source: string, ref: string, at: number): Promise<void>;
    deleteAsset(id: number): Promise<void>;
    /** Une lecture complète : l'inventaire remplace le précédent, ses empreintes aussi. */
    saveScan(
        id: number,
        scan: {
            revision: string | null;
            digest: string | null;
            summaryEnc: string;
            inventoryEnc: string;
            keys: readonly string[];
            at: number;
        }
    ): Promise<void>;
    /** La source consultée n'a rien de neuf : l'inventaire reste. */
    saveCheck(id: number, revision: string | null, at: number): Promise<void>;
    /** Une lecture en échec : l'inventaire d'avant reste, l'erreur s'y ajoute. */
    saveError(id: number, errorEnc: string, at: number): Promise<void>;
    /** Remis dans la veille, un élément repart comme neuf : son inventaire suivant se récapitule. */
    setExcluded(id: number, excluded: boolean): Promise<void>;
    /** Ces éléments ont eu leur premier inventaire évalué. */
    markAnnounced(ids: readonly number[]): Promise<void>;
    askRefresh(id: number): Promise<void>;
    /** Les espaces dont un élément porte l'une de ces empreintes. */
    workspacesWithKeys(keys: readonly string[]): Promise<number[]>;

    listFindings(workspaceId: number): Promise<FindingRow[]>;
    findFinding(workspaceId: number, id: number): Promise<FindingRow | null>;
    linksOf(workspaceId: number): Promise<FindingLinkRow[]>;
    insertFinding(workspaceId: number, write: FindingWrite, at: number): Promise<number>;
    updateFinding(
        id: number,
        write: FindingWrite,
        state: 'open' | 'ignored',
        reopened: boolean,
        at: number
    ): Promise<void>;
    resolveFinding(id: number, at: number): Promise<void>;
    /** Les éléments que le constat touche, et ceux que sa décision couvre. */
    setLinks(findingId: number, assetIds: readonly number[], covered: readonly number[]): Promise<void>;
    ignoreFinding(id: number, userId: number, reasonEnc: string | null, at: number): Promise<void>;
    restoreFinding(id: number): Promise<void>;
    /** Les constats ouverts par genre et gravité, qui touchent au moins l'un de ces éléments. */
    countOpen(workspaceId: number, assetIds: readonly number[]): Promise<CountRow[]>;
    /** Combien de constats ouverts touchent chaque élément de l'espace. */
    openByAsset(workspaceId: number): Promise<{ asset_id: number; n: number }[]>;
    purgeResolved(before: number): Promise<number>;

    osvQueries(keys: readonly string[], freshSince: number): Promise<{ pkg_key: string; vuln_ids: string }[]>;
    saveOsvQueries(entries: readonly { key: string; vulnIds: string }[], at: number): Promise<void>;
    osvVulns(ids: readonly string[], freshSince: number): Promise<{ id: string; body: string }[]>;
    saveOsvVulns(entries: readonly { id: string; body: string }[], at: number): Promise<void>;
    pruneOsvCache(before: number): Promise<void>;
    osvCacheSize(): Promise<{ queries: number; vulns: number }>;
}

const ASSET_COLUMNS =
    'id, workspace_id, source, ref, status, excluded, revision, digest, checked_at, scanned_at, refresh_asked, announced, error_enc, summary_enc, inventory_enc, created';

const FINDING_COLUMNS =
    'id, workspace_id, kind, origin, subject_key, advisory_id, severity, score, state, first_seen, last_seen, resolved_at, due_at, notified_stage, content_enc, ignored_by, ignored_at, reason_enc';

export function createExposureRepo(q: SdkQueryable): ExposureRepo {
    return {
        async listAssets(workspaceId) {
            return q.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM ft_cve_assets WHERE workspace_id = ? ORDER BY id`, [
                workspaceId
            ]);
        },
        async findAsset(workspaceId, id) {
            const rows = await q.query<AssetRow>(
                `SELECT ${ASSET_COLUMNS} FROM ft_cve_assets WHERE workspace_id = ? AND id = ?`,
                [workspaceId, id]
            );
            return rows[0] ?? null;
        },
        async insertAsset(workspaceId, source, ref, at) {
            await q.execute(
                'INSERT IGNORE INTO ft_cve_assets (workspace_id, source, ref, created) VALUES (?, ?, ?, ?)',
                [workspaceId, source, ref, at]
            );
        },
        async deleteAsset(id) {
            await q.execute('DELETE FROM ft_cve_assets WHERE id = ?', [id]);
        },
        async saveScan(id, scan) {
            await q.execute(
                `UPDATE ft_cve_assets
                    SET status = 'ok', revision = ?, digest = ?, summary_enc = ?, inventory_enc = ?,
                        error_enc = NULL, checked_at = ?, scanned_at = ?, refresh_asked = 0
                  WHERE id = ?`,
                [scan.revision, scan.digest, scan.summaryEnc, scan.inventoryEnc, scan.at, scan.at, id]
            );
            await q.execute('DELETE FROM ft_cve_asset_keys WHERE asset_id = ?', [id]);
            const keys = [...new Set(scan.keys)];
            for (let i = 0; i < keys.length; i += 500) {
                const chunk = keys.slice(i, i + 500);
                await q.execute('INSERT IGNORE INTO ft_cve_asset_keys (asset_id, key_hash) VALUES ?', [
                    chunk.map((k) => [id, k])
                ]);
            }
        },
        async saveCheck(id, revision, at) {
            await q.execute(
                `UPDATE ft_cve_assets
                    SET revision = ?, checked_at = ?, refresh_asked = 0,
                        status = IF(scanned_at IS NULL, status, 'ok'), error_enc = NULL
                  WHERE id = ?`,
                [revision, at, id]
            );
        },
        async saveError(id, errorEnc, at) {
            await q.execute(
                "UPDATE ft_cve_assets SET status = 'error', error_enc = ?, checked_at = ?, refresh_asked = 0 WHERE id = ?",
                [errorEnc, at, id]
            );
        },
        async setExcluded(id, excluded) {
            await q.execute('UPDATE ft_cve_assets SET excluded = ?, announced = IF(?, announced, 0) WHERE id = ?', [
                excluded ? 1 : 0,
                excluded,
                id
            ]);
        },
        async markAnnounced(ids) {
            if (ids.length === 0) return;
            await q.execute('UPDATE ft_cve_assets SET announced = 1 WHERE id IN (?)', [[...ids]]);
        },
        async askRefresh(id) {
            await q.execute('UPDATE ft_cve_assets SET refresh_asked = 1 WHERE id = ?', [id]);
        },
        async workspacesWithKeys(keys) {
            if (keys.length === 0) return [];
            const rows = await q.query<{ workspace_id: number }>(
                `SELECT DISTINCT a.workspace_id
                   FROM ft_cve_asset_keys k
                   JOIN ft_cve_assets a ON a.id = k.asset_id
                  WHERE k.key_hash IN (?)`,
                [[...keys]]
            );
            return rows.map((r) => Number(r.workspace_id));
        },

        async listFindings(workspaceId) {
            return q.query<FindingRow>(`SELECT ${FINDING_COLUMNS} FROM ft_cve_findings WHERE workspace_id = ?`, [
                workspaceId
            ]);
        },
        async findFinding(workspaceId, id) {
            const rows = await q.query<FindingRow>(
                `SELECT ${FINDING_COLUMNS} FROM ft_cve_findings WHERE workspace_id = ? AND id = ?`,
                [workspaceId, id]
            );
            return rows[0] ?? null;
        },
        async linksOf(workspaceId) {
            return q.query<FindingLinkRow>(
                `SELECT l.finding_id, l.asset_id, l.covered
                   FROM ft_cve_finding_assets l
                   JOIN ft_cve_findings f ON f.id = l.finding_id
                  WHERE f.workspace_id = ?`,
                [workspaceId]
            );
        },
        async insertFinding(workspaceId, w, at) {
            const res = await q.execute(
                `INSERT INTO ft_cve_findings
                    (workspace_id, kind, origin, subject_key, advisory_id, severity, score, state, first_seen, last_seen, content_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
                [workspaceId, w.kind, w.origin, w.subjectKey, w.advisoryId, w.severity, w.score, at, at, w.contentEnc]
            );
            return res.insertId;
        },
        async updateFinding(id, w, state, reopened, at) {
            // Rouvrir efface la décision d'avant et ce qui a été annoncé : le
            // constat repart comme neuf.
            await q.execute(
                `UPDATE ft_cve_findings
                    SET origin = ?, advisory_id = ?, severity = ?, score = ?, content_enc = ?, last_seen = ?, state = ?,
                        resolved_at = NULL,
                        notified_stage = IF(?, NULL, notified_stage),
                        ignored_by = IF(?, NULL, ignored_by),
                        ignored_at = IF(?, NULL, ignored_at),
                        reason_enc = IF(?, NULL, reason_enc)
                  WHERE id = ?`,
                [
                    w.origin,
                    w.advisoryId,
                    w.severity,
                    w.score,
                    w.contentEnc,
                    at,
                    state,
                    reopened,
                    reopened,
                    reopened,
                    reopened,
                    id
                ]
            );
        },
        async resolveFinding(id, at) {
            await q.execute("UPDATE ft_cve_findings SET state = 'resolved', resolved_at = ? WHERE id = ?", [at, id]);
            await q.execute('DELETE FROM ft_cve_finding_assets WHERE finding_id = ?', [id]);
        },
        async setLinks(findingId, assetIds, covered) {
            await q.execute('DELETE FROM ft_cve_finding_assets WHERE finding_id = ?', [findingId]);
            if (assetIds.length === 0) return;
            const kept = new Set(covered);
            await q.execute('INSERT IGNORE INTO ft_cve_finding_assets (finding_id, asset_id, covered) VALUES ?', [
                assetIds.map((id) => [findingId, id, kept.has(id) ? 1 : 0])
            ]);
        },
        async ignoreFinding(id, userId, reasonEnc, at) {
            await q.execute(
                "UPDATE ft_cve_findings SET state = 'ignored', ignored_by = ?, ignored_at = ?, reason_enc = ? WHERE id = ?",
                [userId, at, reasonEnc, id]
            );
            await q.execute('UPDATE ft_cve_finding_assets SET covered = 1 WHERE finding_id = ?', [id]);
        },
        async restoreFinding(id) {
            await q.execute(
                "UPDATE ft_cve_findings SET state = 'open', ignored_by = NULL, ignored_at = NULL, reason_enc = NULL WHERE id = ?",
                [id]
            );
            await q.execute('UPDATE ft_cve_finding_assets SET covered = 0 WHERE finding_id = ?', [id]);
        },
        async countOpen(workspaceId, assetIds) {
            if (assetIds.length === 0) return [];
            return q.query<CountRow>(
                `SELECT f.kind, f.severity, COUNT(DISTINCT f.id) AS n
                   FROM ft_cve_findings f
                   JOIN ft_cve_finding_assets l ON l.finding_id = f.id
                  WHERE f.workspace_id = ? AND f.state = 'open' AND l.asset_id IN (?)
                  GROUP BY f.kind, f.severity`,
                [workspaceId, [...assetIds]]
            );
        },
        async openByAsset(workspaceId) {
            return q.query<{ asset_id: number; n: number }>(
                `SELECT l.asset_id, COUNT(*) AS n
                   FROM ft_cve_finding_assets l
                   JOIN ft_cve_findings f ON f.id = l.finding_id
                  WHERE f.workspace_id = ? AND f.state = 'open'
                  GROUP BY l.asset_id`,
                [workspaceId]
            );
        },
        async purgeResolved(before) {
            const res = await q.execute("DELETE FROM ft_cve_findings WHERE state = 'resolved' AND resolved_at < ?", [
                before
            ]);
            return res.affectedRows;
        },

        async osvQueries(keys, freshSince) {
            if (keys.length === 0) return [];
            return q.query<{ pkg_key: string; vuln_ids: string }>(
                'SELECT pkg_key, vuln_ids FROM ft_cve_osv_queries WHERE pkg_key IN (?) AND fetched_at >= ?',
                [[...keys], freshSince]
            );
        },
        async saveOsvQueries(entries, at) {
            for (const e of entries) {
                await q.execute(
                    `INSERT INTO ft_cve_osv_queries (pkg_key, vuln_ids, fetched_at) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE vuln_ids = VALUES(vuln_ids), fetched_at = VALUES(fetched_at)`,
                    [e.key, e.vulnIds, at]
                );
            }
        },
        async osvVulns(ids, freshSince) {
            if (ids.length === 0) return [];
            return q.query<{ id: string; body: string }>(
                'SELECT id, body FROM ft_cve_osv_vulns WHERE id IN (?) AND fetched_at >= ?',
                [[...ids], freshSince]
            );
        },
        async saveOsvVulns(entries, at) {
            for (const e of entries) {
                await q.execute(
                    `INSERT INTO ft_cve_osv_vulns (id, body, fetched_at) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE body = VALUES(body), fetched_at = VALUES(fetched_at)`,
                    [e.id, e.body, at]
                );
            }
        },
        async pruneOsvCache(before) {
            await q.execute('DELETE FROM ft_cve_osv_queries WHERE fetched_at < ?', [before]);
            await q.execute('DELETE FROM ft_cve_osv_vulns WHERE fetched_at < ?', [before]);
        },
        async osvCacheSize() {
            const rows = await q.query<{ queries: number; vulns: number }>(
                `SELECT (SELECT COUNT(*) FROM ft_cve_osv_queries) AS queries,
                        (SELECT COUNT(*) FROM ft_cve_osv_vulns) AS vulns`
            );
            return { queries: Number(rows[0]?.queries ?? 0), vulns: Number(rows[0]?.vulns ?? 0) };
        }
    };
}
