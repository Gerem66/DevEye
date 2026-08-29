import { createHash } from 'node:crypto';

import {
    SEVERITY_BY_RANK,
    SEVERITY_RANK,
    type BaselineAttrs,
    type BaselineKind,
    type EvidenceItem,
    type FindingSeverity,
    type FindingState,
    type SentinelRuleId
} from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

type Q = SdkQueryable;

/**
 * Persistance de Sentinelle : la ligne de base (ce qu'on a observé), les constats
 * (ce qu'on en a jugé), les autorisations (ce qu'un humain a décidé) et la config
 * par appareil (ce qu'on surveille). Rien n'est chiffré, ce sont des faits sur
 * des machines : c'est ce qui laisse le moteur tourner sans session ni mot de
 * passe.
 *
 * Aucune jointure vers `devices` : les lignes rendent `device_id`, les handlers
 * résolvent les noms par la façade des appareils. Les clés étrangères vers
 * `devices` restent, ce sont des contraintes, pas des lectures.
 */

/**
 * L'empreinte qui porte l'unicité, partout où une clé peut être un chemin : un
 * chemin de 512 caractères en utf8mb4 pèse 2048 octets, et l'index composé
 * dépasserait la limite InnoDB de 3072. La colonne lisible reste pour l'affichage.
 */
function hashKey(key: string): Buffer {
    return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Séparateur des clés composées (règle + sujet), écrit en échappement et non en
 * caractère littéral : invisible dans la source, il se perdrait au premier
 * copier-coller, et le perdre changerait toutes les empreintes de dédoublonnage
 * d'un coup. Un NUL plutôt qu'un espace parce qu'un sujet est souvent un chemin :
 * seul un octet interdit dans les deux composants lève l'ambiguïté.
 */
const KEY_SEP = '\u0000';

/** La clé de dédoublonnage d'un constat : une situation, une ligne. */
export function findingDedup(rule: SentinelRuleId, subject: string): Buffer {
    return createHash('sha256').update(`${rule}${KEY_SEP}${subject}`, 'utf8').digest();
}

export interface BaselineRow {
    id: number;
    device_id: string;
    kind: BaselineKind;
    item_key: string;
    first_seen: number;
    last_seen: number;
    samples: number;
    attrs: string | BaselineAttrs;
}

/** Ce qu'un tour d'observation veut écrire pour un élément. */
export interface BaselineObservation {
    kind: BaselineKind;
    key: string;
    attrs: BaselineAttrs;
}

export interface BaselineRepo {
    /**
     * Enregistre les éléments vus à cet instant. Un seul `INSERT … ON DUPLICATE
     * KEY UPDATE` multi-lignes : une machine à trois cents programmes ferait
     * sinon trois cents allers-retours par tour. `first_seen` n'est jamais
     * réécrit, l'écraser rajeunirait tout ce qui tourne à chaque tour.
     */
    observe(deviceId: string, at: number, items: BaselineObservation[]): Promise<void>;
    known(deviceId: string, kind: BaselineKind): Promise<Map<string, BaselineRow>>;
    list(deviceId: string, kind: BaselineKind | null, limit: number): Promise<{ rows: BaselineRow[]; total: number }>;
    /** Éléments d'une nature absents depuis `since` : ce qui était là et ne l'est plus. */
    staleSince(deviceId: string, kind: BaselineKind, since: number): Promise<BaselineRow[]>;
    /** Oublie les éléments d'une nature (diff de persistance : on réécrit tout). */
    forget(deviceId: string, kind: BaselineKind, keys: string[]): Promise<number>;
    /** Efface toute la ligne de base d'un appareil. Les autorisations survivent. */
    reset(deviceId: string): Promise<number>;
}

function parseAttrs(raw: string | BaselineAttrs): BaselineAttrs {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw) as BaselineAttrs;
    } catch {
        // Un blob illisible est un défaut de stockage, pas une entrée absente : une
        // enveloppe vide plutôt que tout le tour qui tombe.
        return {
            users: [],
            listenPorts: [],
            cpuP95: null,
            memP95: null,
            sha256: null,
            surface: null
        };
    }
}

function hydrate(row: BaselineRow): BaselineRow {
    return {
        ...row,
        first_seen: Number(row.first_seen),
        last_seen: Number(row.last_seen),
        samples: Number(row.samples),
        attrs: parseAttrs(row.attrs)
    };
}

export function baselineRepo(q: Q): BaselineRepo {
    return {
        async observe(deviceId, at, items) {
            if (items.length === 0) return;
            const values: unknown[] = [];
            const placeholders = items
                .map((item) => {
                    values.push(
                        deviceId,
                        item.kind,
                        item.key.slice(0, 512),
                        hashKey(item.key),
                        at,
                        at,
                        JSON.stringify(item.attrs)
                    );
                    return '(?, ?, ?, ?, ?, ?, 1, ?)';
                })
                .join(', ');
            await q.execute(
                `INSERT INTO device_baseline
                     (device_id, kind, item_key, item_hash, first_seen, last_seen, samples, attrs)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen),
                                         samples   = samples + 1,
                                         attrs     = VALUES(attrs)`,
                values
            );
        },
        async known(deviceId, kind) {
            const rows = await q.query<BaselineRow>(
                `SELECT id, device_id, kind, item_key, first_seen, last_seen, samples, attrs
                 FROM device_baseline WHERE device_id = ? AND kind = ?`,
                [deviceId, kind]
            );
            const out = new Map<string, BaselineRow>();
            for (const row of rows) out.set(row.item_key, hydrate(row));
            return out;
        },
        async list(deviceId, kind, limit) {
            const where = kind ? 'device_id = ? AND kind = ?' : 'device_id = ?';
            const params = kind ? [deviceId, kind] : [deviceId];
            const [page, count] = await Promise.all([
                q.query<BaselineRow>(
                    `SELECT id, device_id, kind, item_key, first_seen, last_seen, samples, attrs
                     FROM device_baseline WHERE ${where}
                     ORDER BY last_seen DESC, item_key ASC
                     LIMIT ${Number(limit)}`,
                    params
                ),
                q.query<{ total: number }>(`SELECT COUNT(*) AS total FROM device_baseline WHERE ${where}`, params)
            ]);
            return {
                rows: page.map(hydrate),
                total: Number(count[0]?.total ?? 0)
            };
        },
        async staleSince(deviceId, kind, since) {
            const rows = await q.query<BaselineRow>(
                `SELECT id, device_id, kind, item_key, first_seen, last_seen, samples, attrs
                 FROM device_baseline
                 WHERE device_id = ? AND kind = ? AND last_seen < ?`,
                [deviceId, kind, since]
            );
            return rows.map(hydrate);
        },
        async forget(deviceId, kind, keys) {
            if (keys.length === 0) return 0;
            const hashes = keys.map(hashKey);
            const marks = hashes.map(() => '?').join(', ');
            const del = await q.execute(
                `DELETE FROM device_baseline
                 WHERE device_id = ? AND kind = ? AND item_hash IN (${marks})`,
                [deviceId, kind, ...hashes]
            );
            return del.affectedRows;
        },
        async reset(deviceId) {
            const del = await q.execute('DELETE FROM device_baseline WHERE device_id = ?', [deviceId]);
            return del.affectedRows;
        }
    };
}

export interface FindingRow {
    id: number;
    device_id: string;
    rule: SentinelRuleId;
    severity: number;
    state: FindingState;
    subject: string;
    evidence: string | EvidenceItem[];
    snapshot_ts: number | null;
    first_seen: number;
    last_seen: number;
    occurrences: number;
    notified: number;
    acked_by: number | null;
    acked_at: number | null;
}

/** Ce qu'une règle produit, avant d'être rapproché de l'état en base. */
export interface FindingDraft {
    rule: SentinelRuleId;
    severity: FindingSeverity;
    subject: string;
    evidence: EvidenceItem[];
    snapshotTs: number | null;
}

/** L'issue d'un enregistrement : ce qui décide s'il faut notifier. */
export interface FindingUpsert {
    id: number;
    /** Vrai au tout premier déclenchement, ou à une réouverture après résolution. */
    isNew: boolean;
    severity: FindingSeverity;
}

export interface FindingsFilter {
    workspaceDeviceIds: string[];
    deviceId: string | null;
    state: FindingState | null;
    minSeverity: FindingSeverity | null;
    rule: SentinelRuleId | null;
    limit: number;
    offset: number;
}

export interface FindingsRepo {
    /**
     * Ouvre le constat, ou fait monter son compteur. `isNew` distingue les deux et
     * autorise seul une notification : sans lui, une situation qui dure notifierait
     * à chaque tour. Un constat `acknowledged` ne rouvre pas, seule la levée de
     * l'autorisation le fait revenir ; un `resolved` rouvre, la situation est
     * revenue.
     */
    upsert(deviceId: string, draft: FindingDraft, at: number): Promise<FindingUpsert>;
    /** Marque résolus les constats ouverts d'un appareil absents de `keep`. */
    resolveMissing(deviceId: string, rules: SentinelRuleId[], keep: Buffer[], at: number): Promise<number>;
    find(findingId: number): Promise<FindingRow | null>;
    list(filter: FindingsFilter): Promise<{ rows: FindingRow[]; total: number }>;
    openCounts(deviceIds: string[]): Promise<Record<FindingSeverity, number>>;
    acknowledge(findingId: number, userId: number, at: number): Promise<void>;
    /**
     * Ferme un constat parce que la situation a cessé, sans le juger normal. Même
     * état que la résolution automatique, seul diffère qui l'a constatée : un état
     * de plus serait à traiter partout où `resolved` l'est déjà.
     */
    resolve(findingId: number, at: number): Promise<void>;
    reopen(findingId: number, at: number): Promise<void>;
    markNotified(ids: number[]): Promise<void>;
    /** Balaye les constats résolus au-delà de la rétention. Les ouverts survivent. */
    pruneResolved(days: number): Promise<number>;
}

function parseEvidence(raw: string | EvidenceItem[]): EvidenceItem[] {
    if (typeof raw !== 'string') return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as EvidenceItem[]) : [];
    } catch {
        return [];
    }
}

function hydrateFinding(row: FindingRow): FindingRow {
    return {
        ...row,
        severity: Number(row.severity),
        snapshot_ts: row.snapshot_ts === null ? null : Number(row.snapshot_ts),
        first_seen: Number(row.first_seen),
        last_seen: Number(row.last_seen),
        occurrences: Number(row.occurrences),
        notified: Number(row.notified),
        acked_at: row.acked_at === null ? null : Number(row.acked_at),
        evidence: parseEvidence(row.evidence)
    };
}

/** `IN (?)` ne se paramètre pas : on fabrique les marques et on passe les valeurs. */
function marksFor(items: readonly unknown[]): string {
    return items.map(() => '?').join(', ');
}

const FINDING_SELECT = `SELECT f.id, f.device_id, f.rule, f.severity, f.state,
                               f.subject, f.evidence, f.snapshot_ts, f.first_seen, f.last_seen,
                               f.occurrences, f.notified, f.acked_by, f.acked_at
                        FROM device_findings f`;

export function findingsRepo(q: Q): FindingsRepo {
    return {
        async upsert(deviceId, draft, at) {
            const dedup = findingDedup(draft.rule, draft.subject);
            const rank = SEVERITY_RANK[draft.severity];

            // On lit avant d'écrire parce que « faut-il notifier » dépend de l'état
            // précédent, qu'un INSERT … ON DUPLICATE ne rend pas. La lecture porte
            // sur la clé unique, donc elle est indexée.
            const existing = await q.query<{ id: number; state: FindingState }>(
                'SELECT id, state FROM device_findings WHERE device_id = ? AND dedup_hash = ?',
                [deviceId, dedup]
            );
            const row = existing[0];

            if (!row) {
                const ins = await q.execute(
                    `INSERT INTO device_findings
                         (device_id, rule, dedup_hash, severity, state, subject, evidence,
                          snapshot_ts, first_seen, last_seen, occurrences)
                     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1)`,
                    [
                        deviceId,
                        draft.rule,
                        dedup,
                        rank,
                        draft.subject.slice(0, 512),
                        JSON.stringify(draft.evidence),
                        draft.snapshotTs,
                        at,
                        at
                    ]
                );
                return { id: ins.insertId, isNew: true, severity: draft.severity };
            }

            // Un constat acquitté reste acquitté tant que son autorisation n'est pas
            // levée : on ne fait que dater.
            if (row.state === 'acknowledged') {
                await q.execute(
                    'UPDATE device_findings SET last_seen = ?, occurrences = occurrences + 1 WHERE id = ?',
                    [at, row.id]
                );
                return { id: row.id, isNew: false, severity: draft.severity };
            }

            const reopened = row.state === 'resolved';
            await q.execute(
                `UPDATE device_findings
                 SET state = 'open', severity = ?, last_seen = ?, occurrences = occurrences + 1,
                     notified = IF(?, 0, notified)
                 WHERE id = ?`,
                [rank, at, reopened ? 1 : 0, row.id]
            );
            return { id: row.id, isNew: reopened, severity: draft.severity };
        },

        async resolveMissing(deviceId, rules, keep, at) {
            if (rules.length === 0) return 0;
            // `keep` vide est un cas normal (plus rien ne déclenche) : la clause
            // `NOT IN ()` étant invalide en SQL, on l'omet alors entièrement.
            const keepClause = keep.length > 0 ? `AND dedup_hash NOT IN (${marksFor(keep)})` : '';
            const upd = await q.execute(
                `UPDATE device_findings
                 SET state = 'resolved', last_seen = ?
                 WHERE device_id = ? AND state = 'open'
                   AND rule IN (${marksFor(rules)}) ${keepClause}`,
                [at, deviceId, ...rules, ...keep]
            );
            return upd.affectedRows;
        },

        async find(findingId) {
            const rows = await q.query<FindingRow>(`${FINDING_SELECT} WHERE f.id = ?`, [findingId]);
            const row = rows[0];
            return row ? hydrateFinding(row) : null;
        },

        async list(filter) {
            if (filter.workspaceDeviceIds.length === 0) return { rows: [], total: 0 };

            const clauses = [`f.device_id IN (${marksFor(filter.workspaceDeviceIds)})`];
            const params: unknown[] = [...filter.workspaceDeviceIds];
            if (filter.deviceId) {
                clauses.push('f.device_id = ?');
                params.push(filter.deviceId);
            }
            if (filter.state) {
                clauses.push('f.state = ?');
                params.push(filter.state);
            }
            if (filter.minSeverity) {
                clauses.push('f.severity >= ?');
                params.push(SEVERITY_RANK[filter.minSeverity]);
            }
            if (filter.rule) {
                clauses.push('f.rule = ?');
                params.push(filter.rule);
            }
            const where = clauses.join(' AND ');

            const [page, count] = await Promise.all([
                q.query<FindingRow>(
                    `${FINDING_SELECT} WHERE ${where}
                     ORDER BY f.severity DESC, f.last_seen DESC
                     LIMIT ${Number(filter.limit)} OFFSET ${Number(filter.offset)}`,
                    params
                ),
                q.query<{ total: number }>(`SELECT COUNT(*) AS total FROM device_findings f WHERE ${where}`, params)
            ]);
            return { rows: page.map(hydrateFinding), total: Number(count[0]?.total ?? 0) };
        },

        async openCounts(deviceIds) {
            const empty: Record<FindingSeverity, number> = { info: 0, low: 0, high: 0, critical: 0 };
            if (deviceIds.length === 0) return empty;
            const rows = await q.query<{ severity: number; n: number }>(
                `SELECT severity, COUNT(*) AS n FROM device_findings
                 WHERE state = 'open' AND device_id IN (${marksFor(deviceIds)})
                 GROUP BY severity`,
                deviceIds
            );
            for (const row of rows) {
                const name = SEVERITY_BY_RANK[Number(row.severity)];
                if (name) empty[name] = Number(row.n);
            }
            return empty;
        },

        async acknowledge(findingId, userId, at) {
            await q.execute(
                `UPDATE device_findings SET state = 'acknowledged', acked_by = ?, acked_at = ? WHERE id = ?`,
                [userId, at, findingId]
            );
        },

        async resolve(findingId, at) {
            // `state = 'open'` en garde : sans elle, un double clic rouvrirait la
            // fenêtre de rétention d'un constat résolu, et « réglé » écraserait un
            // acquittement.
            await q.execute(
                `UPDATE device_findings SET state = 'resolved', last_seen = ? WHERE id = ? AND state = 'open'`,
                [at, findingId]
            );
        },

        async reopen(findingId, at) {
            await q.execute(
                `UPDATE device_findings
                 SET state = 'open', acked_by = NULL, acked_at = NULL, last_seen = ?
                 WHERE id = ?`,
                [at, findingId]
            );
        },

        async markNotified(ids) {
            if (ids.length === 0) return;
            await q.execute(`UPDATE device_findings SET notified = 1 WHERE id IN (${marksFor(ids)})`, ids);
        },

        async pruneResolved(days) {
            // Un constat est une preuve : il ne suit pas la rétention des métriques,
            // seuls les résolus s'effacent, jamais les ouverts.
            const del = await q.execute(
                `DELETE FROM device_findings
                 WHERE state = 'resolved' AND last_seen < (UNIX_TIMESTAMP() * 1000) - ? * 86400000`,
                [days]
            );
            return del.affectedRows;
        }
    };
}

export interface AllowRow {
    id: number;
    workspace_id: number;
    device_id: string | null;
    rule: SentinelRuleId;
    subject: string;
    reason: string | null;
    created_by: number;
    created: number;
}

export interface AllowRepo {
    /**
     * Les autorisations qui s'appliquent à un appareil : les siennes, plus celles
     * de portée flotte. Chargées une fois par tour de moteur, la liste est courte.
     */
    forDevice(workspaceId: number, deviceId: string): Promise<Set<string>>;
    list(workspaceId: number, deviceId: string | null): Promise<AllowRow[]>;
    add(entry: {
        workspaceId: number;
        deviceId: string | null;
        rule: SentinelRuleId;
        subject: string;
        reason: string | null;
        createdBy: number;
        at: number;
    }): Promise<AllowRow>;
    find(allowId: number, workspaceId: number): Promise<AllowRow | null>;
    remove(allowId: number, workspaceId: number): Promise<boolean>;
    /** Retire l'autorisation couvrant exactement ce constat, quelle que soit sa portée. */
    removeFor(workspaceId: number, deviceId: string, rule: SentinelRuleId, subject: string): Promise<number>;
}

/** La clé mémoire d'une autorisation, telle que le moteur l'interroge. */
export function allowKey(rule: SentinelRuleId, subject: string): string {
    return `${rule}${KEY_SEP}${subject}`;
}

/**
 * Le sujet d'une clé d'autorisation, sans sa règle. Existe pour que le séparateur
 * ne soit retapé nulle part ailleurs : un octet invisible mal recopié est une
 * erreur qui ne se voit pas en relecture.
 */
export function allowSubject(key: string): string {
    const i = key.indexOf(KEY_SEP);
    return i === -1 ? key : key.slice(i + 1);
}

const ALLOW_SELECT = `SELECT a.id, a.workspace_id, a.device_id,
                             a.rule, a.subject, a.reason, a.created_by, a.created
                      FROM sentinel_allowlist a`;

function hydrateAllow(row: AllowRow): AllowRow {
    return { ...row, created: Number(row.created) };
}

export function allowRepo(q: Q): AllowRepo {
    return {
        async forDevice(workspaceId, deviceId) {
            const rows = await q.query<{ rule: SentinelRuleId; subject: string }>(
                `SELECT rule, subject FROM sentinel_allowlist
                 WHERE workspace_id = ? AND (device_id = ? OR device_id IS NULL)`,
                [workspaceId, deviceId]
            );
            return new Set(rows.map((row) => allowKey(row.rule, row.subject)));
        },
        async list(workspaceId, deviceId) {
            const where = deviceId
                ? 'a.workspace_id = ? AND (a.device_id = ? OR a.device_id IS NULL)'
                : 'a.workspace_id = ?';
            const params = deviceId ? [workspaceId, deviceId] : [workspaceId];
            const rows = await q.query<AllowRow>(
                `${ALLOW_SELECT} WHERE ${where} ORDER BY a.created DESC LIMIT 1000`,
                params
            );
            return rows.map(hydrateAllow);
        },
        async add(entry) {
            // `INSERT … ON DUPLICATE KEY UPDATE` plutôt qu'un test préalable : deux
            // personnes qui acquittent le même constat en même temps ne doivent pas
            // voir l'une des deux échouer sur une contrainte.
            await q.execute(
                `INSERT INTO sentinel_allowlist
                     (workspace_id, device_id, rule, subject, subject_hash, reason, created_by, created)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE reason = VALUES(reason), created_by = VALUES(created_by)`,
                [
                    entry.workspaceId,
                    entry.deviceId,
                    entry.rule,
                    entry.subject.slice(0, 512),
                    hashKey(entry.subject),
                    entry.reason,
                    entry.createdBy,
                    entry.at
                ]
            );
            const rows = await q.query<AllowRow>(
                `${ALLOW_SELECT} WHERE a.workspace_id = ? AND a.rule = ? AND a.subject_hash = ?
                   AND (a.device_id = ? OR (a.device_id IS NULL AND ? IS NULL))`,
                [entry.workspaceId, entry.rule, hashKey(entry.subject), entry.deviceId, entry.deviceId]
            );
            const row = rows[0];
            if (!row) throw new Error('Autorisation écrite mais introuvable');
            return hydrateAllow(row);
        },
        async find(allowId, workspaceId) {
            const rows = await q.query<AllowRow>(`${ALLOW_SELECT} WHERE a.id = ? AND a.workspace_id = ?`, [
                allowId,
                workspaceId
            ]);
            const row = rows[0];
            return row ? hydrateAllow(row) : null;
        },
        async remove(allowId, workspaceId) {
            const del = await q.execute('DELETE FROM sentinel_allowlist WHERE id = ? AND workspace_id = ?', [
                allowId,
                workspaceId
            ]);
            return del.affectedRows > 0;
        },
        async removeFor(workspaceId, deviceId, rule, subject) {
            const del = await q.execute(
                `DELETE FROM sentinel_allowlist
                 WHERE workspace_id = ? AND rule = ? AND subject_hash = ?
                   AND (device_id = ? OR device_id IS NULL)`,
                [workspaceId, rule, hashKey(subject), deviceId]
            );
            return del.affectedRows;
        }
    };
}

/**
 * Les réglages Sentinelle d'un appareil : une ligne par appareil surveillé ou
 * l'ayant été, l'absence de ligne valant « sondes éteintes, défauts ».
 *
 * Table séparée de la config de collecte (`devices.metric_interval_seconds`) :
 * l'une règle ce que l'agent mesure en continu, l'autre décide si on le
 * surveille, et une feature n'a pas à modifier les réglages de l'autre en
 * passant.
 */
export interface DeviceConfigRow {
    device_id: string;
    /**
     * Sentinelle est-elle active sur cet appareil ? Éteinte par défaut : activer
     * la feature ne doit lire les journaux d'authentification de personne, c'est
     * un geste explicite appareil par appareil.
     */
    enabled: number;
    /**
     * Fin de la fenêtre d'apprentissage, unix ms. `null` tant que Sentinelle n'a
     * jamais été activée ; une date passée signifie « apprentissage terminé ».
     */
    learning_until: number | null;
    /** Cadence du manifeste de persistance, en minutes. */
    integrity_minutes: number;
    /** Relever les issues d'authentification (interrupteur propre). */
    auth_events: number;
    /** Unix ms du dernier manifeste reçu ; `null` = jamais mesuré. */
    last_integrity_at: number | null;
}

/** Ce qu'une écriture veut changer ; ce qui n'est pas donné ne bouge pas (ou prend son défaut à la création). */
export interface DeviceConfigPatch {
    enabled?: boolean;
    /** Unix ms de fin d'apprentissage ; `null` remet à zéro. */
    learningUntil?: number | null;
    integrityMinutes?: number;
    authEvents?: boolean;
}

export interface DeviceConfigRepo {
    /** La ligne d'un appareil, ou `null` : sondes éteintes, défauts. */
    get(deviceId: string): Promise<DeviceConfigRow | null>;
    /** Les lignes d'un lot d'appareils, par identifiant : la vue de flotte en une requête. */
    forDevices(deviceIds: string[]): Promise<Map<string, DeviceConfigRow>>;
    /**
     * Écrit les champs donnés, en créant la ligne au passage : le premier réglage
     * d'une machine ne se distingue pas du suivant, et deux écritures concurrentes
     * ne se disputent pas la création.
     */
    set(deviceId: string, patch: DeviceConfigPatch): Promise<void>;
    /** Date le dernier manifeste de persistance reçu (unix ms). */
    touchIntegrity(deviceId: string, at: number): Promise<void>;
    /**
     * Les appareils sur lesquels Sentinelle tourne, tous espaces confondus : le
     * moteur n'a ni session ni espace courant. Le statut (archivé, révoqué) ne se
     * lit pas ici, c'est la façade des appareils qui le dit.
     */
    listEnabled(): Promise<string[]>;
}

const CONFIG_SELECT = `SELECT device_id, enabled, learning_until, integrity_minutes, auth_events, last_integrity_at
                       FROM ft_sentinel_device_config`;

function hydrateConfig(row: DeviceConfigRow): DeviceConfigRow {
    return {
        ...row,
        enabled: Number(row.enabled),
        learning_until: row.learning_until === null ? null : Number(row.learning_until),
        integrity_minutes: Number(row.integrity_minutes),
        auth_events: Number(row.auth_events),
        last_integrity_at: row.last_integrity_at === null ? null : Number(row.last_integrity_at)
    };
}

export function deviceConfigRepo(q: Q): DeviceConfigRepo {
    /** Une écriture par clé, la ligne créée au passage si elle manque. */
    async function upsert(deviceId: string, columns: string[], values: unknown[]): Promise<void> {
        const names = ['device_id', ...columns].join(', ');
        const marks = ['?', ...columns.map(() => '?')].join(', ');
        const updates = columns.map((c) => `${c} = VALUES(${c})`).join(', ');
        await q.execute(
            `INSERT INTO ft_sentinel_device_config (${names}) VALUES (${marks})
             ON DUPLICATE KEY UPDATE ${updates}`,
            [deviceId, ...values]
        );
    }

    return {
        async get(deviceId) {
            const rows = await q.query<DeviceConfigRow>(`${CONFIG_SELECT} WHERE device_id = ?`, [deviceId]);
            const row = rows[0];
            return row ? hydrateConfig(row) : null;
        },
        async forDevices(deviceIds) {
            const out = new Map<string, DeviceConfigRow>();
            if (deviceIds.length === 0) return out;
            const rows = await q.query<DeviceConfigRow>(
                `${CONFIG_SELECT} WHERE device_id IN (${marksFor(deviceIds)})`,
                deviceIds
            );
            for (const row of rows) out.set(row.device_id, hydrateConfig(row));
            return out;
        },
        async set(deviceId, patch) {
            const columns: Record<keyof DeviceConfigPatch, string> = {
                enabled: 'enabled',
                learningUntil: 'learning_until',
                integrityMinutes: 'integrity_minutes',
                authEvents: 'auth_events'
            };
            const sets: string[] = [];
            const params: unknown[] = [];
            for (const key of Object.keys(columns) as (keyof DeviceConfigPatch)[]) {
                const value = patch[key];
                if (value === undefined) continue;
                sets.push(columns[key]);
                // Les deux drapeaux sont des TINYINT : passer des booléens JS
                // marcherait, mais une relecture rendrait alors un autre type que
                // celui qu'on croit écrire.
                params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
            }
            if (sets.length === 0) return;
            await upsert(deviceId, sets, params);
        },
        async touchIntegrity(deviceId, at) {
            await upsert(deviceId, ['last_integrity_at'], [at]);
        },
        async listEnabled() {
            const rows = await q.query<{ device_id: string }>(
                'SELECT device_id FROM ft_sentinel_device_config WHERE enabled = 1 ORDER BY device_id ASC'
            );
            return rows.map((row) => row.device_id);
        }
    };
}

export interface SentinelRepo {
    baseline: BaselineRepo;
    findings: FindingsRepo;
    allow: AllowRepo;
    deviceConfig: DeviceConfigRepo;
}

export function createRepo(q: Q): SentinelRepo {
    return {
        baseline: baselineRepo(q),
        findings: findingsRepo(q),
        allow: allowRepo(q),
        deviceConfig: deviceConfigRepo(q)
    };
}
