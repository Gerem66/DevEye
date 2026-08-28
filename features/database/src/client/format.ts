import type {
    DatabaseComparator,
    DatabaseEngine,
    DatabaseFilterOperator,
    DatabaseStatus,
    DatabaseTable
} from '../contracts/domain';
import type { ProjectStatus } from '@deveye/types';

/** Le nom d'usage d'un moteur, celui que l'utilisateur reconnaît. */
export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL'
};

/**
 * Les libellés des états d'un projet, pour la liste des projets qui utilisent
 * une base.
 *
 * Une copie assumée des quatre libellés de Projets (`STATUS_LABELS` de
 * `features/projects/src/client/api.ts`) : un module n'importe pas un autre
 * module, et le SDK n'expose que le vocabulaire des statuts
 * (`ProjectStatus`), pas ses libellés. Quatre mots, tenus à la main.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
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
 * Les conditions de recherche, dites en français plutôt qu'en SQL.
 *
 * L'ordre n'est pas alphabétique mais celui de l'usage : on cherche d'abord un
 * texte contenu, ensuite une égalité, et les comparaisons en dernier.
 */
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

/** Deux conditions ne prennent pas de valeur : le champ disparaît alors. */
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

/** « 42 ms », « 1,8 s » — un temps de réponse se lit dans son ordre de grandeur. */
export function formatMs(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
}

/**
 * L'ordre alphabétique des tables, celui dans lequel on les cherche.
 *
 * Trié **ici** et non laissé au moteur : `ORDER BY` suit la collation du
 * serveur, qui range volontiers les majuscules avant les minuscules et ignore
 * les accents à sa façon. `localeCompare` donne le même ordre partout, quels que
 * soient le moteur et sa configuration — et c'est le seul ordre qu'on puisse
 * annoncer sans mentir.
 */
export function compareTables(a: DatabaseTable, b: DatabaseTable): number {
    return (
        a.schema.localeCompare(b.schema, 'fr', { sensitivity: 'base' }) ||
        a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
    );
}

/** « 5 min », « 1 h » — une cadence de relevé. */
export function formatInterval(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}
