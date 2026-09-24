import type { Queryable } from '../pool';

type Q = Queryable;

export type FeatureDomainState = 'pending' | 'ok' | 'failed';

export interface FeatureDomainRow {
    id: number;
    workspace_id: number;
    feature: string;
    host: string;
    token: string;
    dns_state: FeatureDomainState;
    dns_error: string;
    probe_state: FeatureDomainState;
    probe_error: string;
    verified_at: number | null;
    checked_at: number | null;
    failures: number;
    next_probe_at: number | null;
    created: number;
}

/** Ce qu'une vérification réécrit, et rien d'autre. */
export type FeatureDomainVerdict = Pick<
    FeatureDomainRow,
    | 'dns_state'
    | 'dns_error'
    | 'probe_state'
    | 'probe_error'
    | 'verified_at'
    | 'checked_at'
    | 'failures'
    | 'next_probe_at'
>;

const COLUMNS =
    'id, workspace_id, feature, host, token, dns_state, dns_error, probe_state, probe_error, verified_at, checked_at, failures, next_probe_at, created';

/** mysql2 rend les BIGINT en chaînes selon la config : on normalise ici. */
function normalise(row: FeatureDomainRow): FeatureDomainRow {
    return {
        ...row,
        verified_at: row.verified_at === null ? null : Number(row.verified_at),
        checked_at: row.checked_at === null ? null : Number(row.checked_at),
        next_probe_at: row.next_probe_at === null ? null : Number(row.next_probe_at),
        created: Number(row.created)
    };
}

export interface FeatureDomainsRepo {
    list(workspaceId: number, feature: string): Promise<FeatureDomainRow[]>;
    find(id: number, workspaceId: number, feature: string): Promise<FeatureDomainRow | null>;
    /** Tous espaces confondus : l'hôte est unique par fonctionnalité. */
    findByHost(feature: string, host: string): Promise<FeatureDomainRow | null>;
    insert(entry: { workspaceId: number; feature: string; host: string; token: string; now: number }): Promise<number>;
    saveState(id: number, verdict: FeatureDomainVerdict): Promise<void>;
    delete(id: number, workspaceId: number, feature: string): Promise<boolean>;
    /** Les domaines à revérifier, restreints aux fonctionnalités installées. */
    due(now: number, limit: number, features: readonly string[]): Promise<FeatureDomainRow[]>;
    /** Les noms distincts de ces espaces, pour ces fonctionnalités : ce qu'une offre compte. */
    hostsOf(workspaceIds: readonly number[], features: readonly string[]): Promise<string[]>;
    /**
     * Les noms que le proxy doit servir : propriété prouvée, ou déjà vérifiés et
     * tenus malgré un échec passager. `verified` dit s'il l'a été une fois.
     */
    routable(features: readonly string[]): Promise<{ host: string; verified: boolean }[]>;
}

export function featureDomainsRepo(pool: Q): FeatureDomainsRepo {
    return {
        async list(workspaceId, feature) {
            const r = await pool.query<FeatureDomainRow>(
                `SELECT ${COLUMNS} FROM feature_domains WHERE workspace_id = ? AND feature = ? ORDER BY host`,
                [workspaceId, feature]
            );
            return r.rows.map(normalise);
        },
        async find(id, workspaceId, feature) {
            const r = await pool.query<FeatureDomainRow>(
                `SELECT ${COLUMNS} FROM feature_domains WHERE id = ? AND workspace_id = ? AND feature = ?`,
                [id, workspaceId, feature]
            );
            return r.rows[0] ? normalise(r.rows[0]) : null;
        },
        async findByHost(feature, host) {
            const r = await pool.query<FeatureDomainRow>(
                `SELECT ${COLUMNS} FROM feature_domains WHERE feature = ? AND host = ?`,
                [feature, host]
            );
            return r.rows[0] ? normalise(r.rows[0]) : null;
        },
        async insert({ workspaceId, feature, host, token, now }) {
            const r = await pool.query(
                'INSERT INTO feature_domains (workspace_id, feature, host, token, next_probe_at, created) VALUES (?, ?, ?, ?, ?, ?)',
                [workspaceId, feature, host, token, now, now]
            );
            return r.insertId;
        },
        async saveState(id, verdict) {
            await pool.query(
                `UPDATE feature_domains
                    SET dns_state = ?, dns_error = ?, probe_state = ?, probe_error = ?,
                        verified_at = ?, checked_at = ?, failures = ?, next_probe_at = ?
                  WHERE id = ?`,
                [
                    verdict.dns_state,
                    verdict.dns_error.slice(0, 255),
                    verdict.probe_state,
                    verdict.probe_error.slice(0, 255),
                    verdict.verified_at,
                    verdict.checked_at,
                    verdict.failures,
                    verdict.next_probe_at,
                    id
                ]
            );
        },
        async delete(id, workspaceId, feature) {
            const r = await pool.query(
                'DELETE FROM feature_domains WHERE id = ? AND workspace_id = ? AND feature = ?',
                [id, workspaceId, feature]
            );
            return r.rowCount > 0;
        },
        async due(now, limit, features) {
            if (features.length === 0) return [];
            const r = await pool.query<FeatureDomainRow>(
                `SELECT ${COLUMNS} FROM feature_domains
                  WHERE next_probe_at IS NOT NULL AND next_probe_at <= ?
                    AND feature IN (${features.map(() => '?').join(', ')})
                  ORDER BY next_probe_at LIMIT ${Math.max(1, Math.floor(limit))}`,
                [now, ...features]
            );
            return r.rows.map(normalise);
        },
        async hostsOf(workspaceIds, features) {
            if (workspaceIds.length === 0 || features.length === 0) return [];
            const r = await pool.query<{ host: string }>(
                `SELECT DISTINCT host FROM feature_domains
                  WHERE workspace_id IN (${workspaceIds.map(() => '?').join(', ')})
                    AND feature IN (${features.map(() => '?').join(', ')})`,
                [...workspaceIds, ...features]
            );
            return r.rows.map((row) => row.host);
        },
        async routable(features) {
            if (features.length === 0) return [];
            const r = await pool.query<{ host: string; verified: number | string }>(
                `SELECT host, MAX(verified_at IS NOT NULL) AS verified FROM feature_domains
                  WHERE (dns_state = 'ok' OR verified_at IS NOT NULL)
                    AND feature IN (${features.map(() => '?').join(', ')})
                  GROUP BY host ORDER BY host`,
                [...features]
            );
            return r.rows.map((row) => ({ host: row.host, verified: Number(row.verified) === 1 }));
        }
    };
}
