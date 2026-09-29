import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ComponentKind, ComponentState, Tracked } from './state';

/**
 * La mémoire de la page d'état : un fichier SQLite sur son propre volume. Pas
 * la base de DevEye : quand elle tombe, c'est justement ce qu'il faut noter.
 * Ni mesure brute : un compteur par jour et les incidents suffisent à la page.
 */

export const DAY = 86_400;
/** Au-delà des 90 jours affichés, de quoi comparer une année. */
export const RETENTION_DAYS = 400;

export interface ComponentRow extends Tracked {
    id: string;
    label: string;
    kind: ComponentKind;
    position: number;
    /** Présent au dernier relevé de DevEye : un module retiré garde son historique, pas sa place. */
    listed: boolean;
}

export interface DailyRow {
    day: number;
    checks: number;
    up: number;
    degraded: number;
    down: number;
    maintenance: number;
}

export interface IncidentRow {
    id: number;
    component: string;
    state: Exclude<ComponentState, 'up'>;
    reason: string | null;
    message: string | null;
    startedAt: number;
    endedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    listed INTEGER NOT NULL DEFAULT 1,
    state TEXT,
    since INTEGER,
    reason TEXT,
    message TEXT,
    inherited INTEGER NOT NULL DEFAULT 0,
    pending TEXT,
    pending_since INTEGER,
    streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily (
    component TEXT NOT NULL,
    day INTEGER NOT NULL,
    checks INTEGER NOT NULL DEFAULT 0,
    up INTEGER NOT NULL DEFAULT 0,
    degraded INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    maintenance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (component, day)
);
CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    message TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS incidents_by_component ON incidents (component, started_at);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

/** Le nom de colonne vient d'ici, jamais d'une valeur reçue. */
const COLUMN: Record<ComponentState, string> = {
    up: 'up',
    degraded: 'degraded',
    down: 'down',
    maintenance: 'maintenance'
};

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function componentOf(row: Row): ComponentRow {
    return {
        id: String(row.id),
        label: String(row.label),
        kind: row.kind as ComponentKind,
        position: Number(row.position),
        listed: Number(row.listed) === 1,
        state: str(row.state) as ComponentState | null,
        since: num(row.since),
        reason: str(row.reason),
        message: str(row.message),
        inherited: Number(row.inherited) === 1,
        pending: str(row.pending) as ComponentState | null,
        pendingSince: num(row.pending_since),
        streak: Number(row.streak)
    };
}

function incidentOf(row: Row): IncidentRow {
    return {
        id: Number(row.id),
        component: String(row.component),
        state: row.state as IncidentRow['state'],
        reason: str(row.reason),
        message: str(row.message),
        startedAt: Number(row.started_at),
        endedAt: num(row.ended_at)
    };
}

export function dayOf(epochSeconds: number): number {
    return Math.floor(epochSeconds / DAY) * DAY;
}

/** `:memory:` pour les tests. */
export function openStore(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);

    const tx = <T>(work: () => T): T => {
        db.exec('BEGIN');
        try {
            const result = work();
            db.exec('COMMIT');
            return result;
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    };

    return {
        tx,

        components(): ComponentRow[] {
            return db.prepare('SELECT * FROM components ORDER BY position, label').all().map(componentOf);
        },

        component(id: string): ComponentRow | null {
            const row = db.prepare('SELECT * FROM components WHERE id = ?').get(id);
            return row ? componentOf(row) : null;
        },

        /** Crée ou renomme un composant, sans toucher à ce qu'il a vécu. */
        declare(id: string, label: string, kind: ComponentKind, position: number): void {
            db.prepare(
                `INSERT INTO components (id, label, kind, position, listed) VALUES (?, ?, ?, ?, 1)
                 ON CONFLICT (id) DO UPDATE SET label = excluded.label, kind = excluded.kind,
                     position = excluded.position, listed = 1`
            ).run(id, label, kind, position);
        },

        /** Les modules absents du dernier relevé quittent la liste. */
        unlistExcept(kind: ComponentKind, ids: readonly string[]): void {
            const kept = new Set(ids);
            for (const c of this.components()) {
                if (c.kind === kind && c.listed && !kept.has(c.id)) {
                    db.prepare('UPDATE components SET listed = 0 WHERE id = ?').run(c.id);
                }
            }
        },

        track(id: string, t: Tracked): void {
            db.prepare(
                `UPDATE components SET state = ?, since = ?, reason = ?, message = ?, inherited = ?,
                     pending = ?, pending_since = ?, streak = ? WHERE id = ?`
            ).run(t.state, t.since, t.reason, t.message, t.inherited ? 1 : 0, t.pending, t.pendingSince, t.streak, id);
        },

        count(id: string, state: ComponentState, at: number): void {
            const column = COLUMN[state];
            db.prepare(
                `INSERT INTO daily (component, day, checks, ${column}) VALUES (?, ?, 1, 1)
                 ON CONFLICT (component, day) DO UPDATE SET checks = checks + 1, ${column} = ${column} + 1`
            ).run(id, dayOf(at));
        },

        daily(id: string, fromDay: number): DailyRow[] {
            return db
                .prepare(
                    'SELECT day, checks, up, degraded, down, maintenance FROM daily WHERE component = ? AND day >= ? ORDER BY day'
                )
                .all(id, fromDay)
                .map((row) => ({
                    day: Number(row.day),
                    checks: Number(row.checks),
                    up: Number(row.up),
                    degraded: Number(row.degraded),
                    down: Number(row.down),
                    maintenance: Number(row.maintenance)
                }));
        },

        openIncident(
            id: string,
            state: IncidentRow['state'],
            reason: string | null,
            message: string | null,
            at: number
        ) {
            db.prepare(
                'INSERT INTO incidents (component, state, reason, message, started_at) VALUES (?, ?, ?, ?, ?)'
            ).run(id, state, reason, message, at);
        },

        /** Ferme l'incident en cours du composant, s'il en a un. */
        closeIncident(id: string, at: number): void {
            db.prepare(
                'UPDATE incidents SET ended_at = MAX(started_at, ?) WHERE component = ? AND ended_at IS NULL'
            ).run(at, id);
        },

        /** Les incidents qui touchent la période, en cours compris, les plus récents d'abord. */
        incidents(ids: readonly string[], since: number): IncidentRow[] {
            if (ids.length === 0) return [];
            const marks = ids.map(() => '?').join(', ');
            return db
                .prepare(
                    `SELECT * FROM incidents WHERE component IN (${marks}) AND (ended_at IS NULL OR ended_at >= ?)
                     ORDER BY started_at DESC`
                )
                .all(...ids, since)
                .map(incidentOf);
        },

        meta(key: string): string | null {
            const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
            return row ? String(row.value) : null;
        },

        setMeta(key: string, value: string): void {
            db.prepare(
                'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
            ).run(key, value);
        },

        prune(now: number): void {
            const limit = dayOf(now) - RETENTION_DAYS * DAY;
            db.prepare('DELETE FROM daily WHERE day < ?').run(limit);
            db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(limit);
        },

        close(): void {
            db.close();
        }
    };
}

export type Store = ReturnType<typeof openStore>;
