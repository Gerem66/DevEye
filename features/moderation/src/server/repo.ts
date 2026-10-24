import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { RuleExposure, RuleKind, RuleSource } from '../contracts/domain';

/**
 * L'accès aux tables du module. Rien n'est filtré par espace : une règle vaut
 * pour toute l'instance. Le repo ne scelle jamais : il reçoit et rend des
 * blobs déjà scellés par l'appelant.
 */

export interface RuleRow {
    id: number;
    kind: RuleKind;
    pattern: string;
    reason: string;
    label: string;
    exposure: RuleExposure;
    source: RuleSource;
    created_by: number | null;
    hits: number;
    last_hit: number | null;
    created: number;
}

export interface HitRow {
    id: number;
    feature: string;
    rule_id: number | null;
    kind: RuleKind;
    reason: string;
    label: string;
    content: string;
    sha256: string | null;
    size: number | null;
    workspace_id: number | null;
    user_id: number | null;
    dedupe_key: string;
    count: number;
    first_seen: number;
    last_seen: number;
}

export interface RuleInsert {
    kind: RuleKind;
    pattern: string;
    reason: string;
    label: string;
    exposure: RuleExposure;
    source: RuleSource;
    created_by: number | null;
}

export interface ModerationRepo {
    /** Les règles lisibles une à une : tout sauf la liste externe. */
    listRules(): Promise<RuleRow[]>;
    listNameRules(): Promise<RuleRow[]>;
    findRule(id: number): Promise<RuleRow | null>;
    findFingerprint(sha256: string): Promise<RuleRow | null>;
    /** Combien de lignes neuves : un motif déjà posé est laissé tel quel. */
    insertRules(rows: readonly RuleInsert[]): Promise<number>;
    deleteRule(id: number): Promise<number>;
    countBySource(source: RuleSource): Promise<number>;
    /** Une règle qui vient d'arrêter un fichier. */
    bumpRule(id: number, at: number): Promise<void>;

    /** La même détection relue (`dedupe_key`) compte une fois de plus au lieu de s'écrire deux fois. */
    recordHit(row: {
        feature: string;
        rule_id: number;
        kind: RuleKind;
        reason: string;
        label: string;
        content: string;
        sha256: string | null;
        size: number | null;
        workspace_id: number | null;
        user_id: number | null;
        dedupe_key: string;
        at: number;
    }): Promise<void>;
    listHits(limit: number): Promise<HitRow[]>;
    /** Les détections d'un compte, pour l'export de ses données. */
    listHitsOfUser(userId: number): Promise<HitRow[]>;
    countHitsSince(since: number): Promise<number>;
    purgeHits(before: number): Promise<number>;

    getMeta(key: string): Promise<string | null>;
    setMeta(key: string, value: string): Promise<void>;
}

const RULE_COLUMNS = ['kind', 'pattern', 'reason', 'label', 'exposure', 'source', 'created_by'] as const;
/** Une importation se verse par paquets : une requête de cent mille lignes dépasserait la taille d'un paquet MySQL. */
const INSERT_CHUNK = 2_000;

export function createRepo(q: SdkQueryable): ModerationRepo {
    const one = <T extends object>(rows: T[]): T | null => rows[0] ?? null;

    return {
        listRules() {
            return q.query<RuleRow>(
                "SELECT * FROM ft_moderation_rules WHERE source <> 'feed' ORDER BY created DESC, id DESC"
            );
        },

        listNameRules() {
            return q.query<RuleRow>("SELECT * FROM ft_moderation_rules WHERE kind = 'name'");
        },

        async findRule(id) {
            return one(await q.query<RuleRow>('SELECT * FROM ft_moderation_rules WHERE id = ?', [id]));
        },

        async findFingerprint(sha256) {
            return one(
                await q.query<RuleRow>("SELECT * FROM ft_moderation_rules WHERE kind = 'fingerprint' AND pattern = ?", [
                    sha256
                ])
            );
        },

        async insertRules(rows) {
            let added = 0;
            for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
                const chunk = rows.slice(start, start + INSERT_CHUNK).map((row) => RULE_COLUMNS.map((c) => row[c]));
                const res = await q.execute(
                    `INSERT IGNORE INTO ft_moderation_rules (${RULE_COLUMNS.join(', ')}) VALUES ?`,
                    [chunk]
                );
                added += res.affectedRows;
            }
            return added;
        },

        async deleteRule(id) {
            const res = await q.execute('DELETE FROM ft_moderation_rules WHERE id = ?', [id]);
            return res.affectedRows;
        },

        async countBySource(source) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_moderation_rules WHERE source = ?',
                [source]
            );
            return Number(rows[0]?.n ?? 0);
        },

        async bumpRule(id, at) {
            await q.execute('UPDATE ft_moderation_rules SET hits = hits + 1, last_hit = ? WHERE id = ?', [at, id]);
        },

        async recordHit(row) {
            await q.execute(
                `INSERT INTO ft_moderation_hits
                    (feature, rule_id, kind, reason, label, content, sha256, size, workspace_id, user_id, dedupe_key, first_seen, last_seen)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE count = count + 1, last_seen = VALUES(last_seen)`,
                [
                    row.feature,
                    row.rule_id,
                    row.kind,
                    row.reason,
                    row.label,
                    row.content,
                    row.sha256,
                    row.size,
                    row.workspace_id,
                    row.user_id,
                    row.dedupe_key,
                    row.at,
                    row.at
                ]
            );
        },

        listHits(limit) {
            return q.query<HitRow>(
                `SELECT * FROM ft_moderation_hits ORDER BY last_seen DESC, id DESC LIMIT ${Math.max(1, Math.floor(limit))}`
            );
        },

        listHitsOfUser(userId) {
            return q.query<HitRow>(
                'SELECT * FROM ft_moderation_hits WHERE user_id = ? ORDER BY last_seen DESC, id DESC',
                [userId]
            );
        },

        async countHitsSince(since) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_moderation_hits WHERE last_seen >= ?',
                [since]
            );
            return Number(rows[0]?.n ?? 0);
        },

        async purgeHits(before) {
            const res = await q.execute('DELETE FROM ft_moderation_hits WHERE last_seen < ?', [before]);
            return res.affectedRows;
        },

        async getMeta(key) {
            const rows = await q.query<{ v: string }>('SELECT v FROM ft_moderation_meta WHERE k = ?', [key]);
            return rows[0]?.v ?? null;
        },

        async setMeta(key, value) {
            await q.execute(
                'INSERT INTO ft_moderation_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
                [key, value]
            );
        }
    };
}
