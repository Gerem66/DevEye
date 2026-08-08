import type { DatabaseComparator, DatabaseEngine, DatabaseStatus } from 'deveye-types';

/** Le nom d'usage d'un moteur, celui que l'utilisateur reconnaît. */
export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL'
};

/** Port par défaut du moteur : on le propose, sans jamais l'imposer. */
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

/**
 * Ce que l'état d'une base dit à l'écran.
 *
 * `unknown` est neutre, jamais alarmant : c'est l'état normal d'une base qu'on
 * n'a pas encore jointe, ce qui est le cas par défaut de toutes. Le peindre en
 * rouge ferait passer une feature au repos pour une feature en panne.
 */
export const STATUS_META: Record<DatabaseStatus, { label: string; tone: 'neutral' | 'online' | 'danger' }> = {
    unknown: { label: 'jamais testée', tone: 'neutral' },
    up: { label: 'joignable', tone: 'online' },
    down: { label: 'injoignable', tone: 'danger' }
};

/** « 4,2 Go », « 812 Mo » — une taille de base se lit en ordre de grandeur. */
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

/** « 1 284 » — un nombre de lignes se lit par tranches de mille. */
export function formatCount(value: number | null): string {
    return value === null ? '—' : value.toLocaleString('fr-FR');
}

/** « il y a 4 min » — la fraîcheur d'un relevé, pas sa date exacte. */
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

/** « 5 min », « 1 h » — une cadence de relevé. */
export function formatInterval(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}
