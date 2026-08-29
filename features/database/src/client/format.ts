import type {
    DatabaseComparator,
    DatabaseEngine,
    DatabaseFilterOperator,
    DatabaseStatus,
    DatabaseTable
} from '../contracts/domain';
import type { ProjectStatus } from '@deveye/types';

export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL'
};

/**
 * Copie des libellés de Projets (`STATUS_LABELS` de
 * `features/projects/src/client/api.ts`) : un module n'importe pas un autre module.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};

export const ENGINE_PORTS: Record<DatabaseEngine, number> = {
    mysql: 3306,
    postgres: 5432
};

export const COMPARATOR_LABELS: Record<DatabaseComparator, string> = {
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    eq: '=',
    ne: '≠'
};

/** Dans l'ordre d'usage, pas alphabétique. */
export const FILTER_OPERATOR_LABELS: Record<DatabaseFilterOperator, string> = {
    contains: 'contient',
    eq: 'est égal à',
    ne: 'est différent de',
    starts: 'commence par',
    ends: 'finit par',
    gt: 'est supérieur à',
    gte: 'est supérieur ou égal à',
    lt: 'est inférieur à',
    lte: 'est inférieur ou égal à',
    isNull: 'est NULL',
    notNull: 'n’est pas NULL'
};

export const OPERATOR_NEEDS_VALUE: Record<DatabaseFilterOperator, boolean> = {
    contains: true,
    eq: true,
    ne: true,
    starts: true,
    ends: true,
    gt: true,
    gte: true,
    lt: true,
    lte: true,
    isNull: false,
    notNull: false
};

/** `unknown` est neutre, jamais alarmant : l'état normal d'une base jamais jointe. */
export const STATUS_META: Record<DatabaseStatus, { label: string; tone: 'neutral' | 'online' | 'danger' }> = {
    unknown: { label: 'jamais testée', tone: 'neutral' },
    up: { label: 'joignable', tone: 'online' },
    down: { label: 'injoignable', tone: 'danger' }
};

/** « 4,2 Go », « 812 Mo ». */
export function formatBytes(bytes: number | null): string {
    if (bytes === null) return '—';
    const units = ['o', 'ko', 'Mo', 'Go', 'To'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 })} ${units[unit]}`;
}

/** « 1 284 ». */
export function formatCount(value: number | null): string {
    return value === null ? '—' : value.toLocaleString('fr-FR');
}

/** « il y a 4 min ». */
export function formatAgo(epochSeconds: number | null): string {
    if (epochSeconds === null) return 'jamais relevée';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/** « 42 ms », « 1,8 s ». */
export function formatMs(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
}

/**
 * Trié ici et non par le moteur : `ORDER BY` suit la collation du serveur,
 * `localeCompare` donne le même ordre partout.
 */
export function compareTables(a: DatabaseTable, b: DatabaseTable): number {
    return (
        a.schema.localeCompare(b.schema, 'fr', { sensitivity: 'base' }) ||
        a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
    );
}

/** « 5 min », « 1 h ». */
export function formatInterval(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}
