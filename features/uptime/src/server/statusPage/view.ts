import {
    UPTIME_PAGE_DAYS,
    type UptimeDayRow,
    type UptimeIncidentRow,
    type UptimePageTheme,
    type UptimeServiceRow
} from '../../contracts/domain';
import { publicReason } from '../_shared';
import type { UptimeHourLatencyRow } from '../repoPages';

/**
 * Ce que la page publique montre, calculé à partir des lignes et sans rien
 * d'autre : pur, donc éprouvé sans base.
 */

export const DAY = 86400;
const HOUR = 3600;
/** L'historique des pannes remonte un mois, et s'arrête à une vingtaine de lignes. */
export const HISTORY_DAYS = 30;
const HISTORY_MAX = 20;
/** Le temps de réponse se lit sur les dernières 24 heures, heure par heure. */
export const LATENCY_HOURS = 24;

/**
 * Le verdict d'un jour. Rouge dès qu'une panne l'a touché ; jaune pour des
 * sondes en échec restées sous le seuil de panne, que le public n'a sans doute
 * pas vues ; gris quand rien n'a été mesuré.
 */
export type BarTone = 'up' | 'degraded' | 'down' | 'empty';

export interface StatusBar {
    /** Minuit UTC du jour. */
    day: number;
    tone: BarTone;
    /** Part des sondes réussies, `null` sans mesure. */
    ratio: number | null;
    /** Secondes de panne dans la journée. */
    downSeconds: number;
}

export type ServiceState = 'up' | 'down' | 'pending' | 'paused';

export interface StatusServiceView {
    name: string;
    state: ServiceState;
    bars: StatusBar[];
    /** Disponibilité sur toute la fenêtre des barres. */
    ratio: number | null;
    /** `null` quand la page ne montre pas le temps de réponse. */
    latency: { points: (number | null)[]; avgMs: number | null } | null;
    /** La cadence des sondes, en secondes ; `null` pour un service en pause, qui n'en a pas. */
    intervalSeconds: number | null;
}

export interface StatusIncidentView {
    service: string;
    startedAt: number;
    endedAt: number | null;
    /** La catégorie de la panne, `null` quand la page ne la montre pas. */
    reason: string | null;
}

export interface StatusBanner {
    tone: 'up' | 'down' | 'pending' | 'paused';
    /** Services en panne, sur ceux qui sont surveillés. */
    down: number;
    watched: number;
}

export interface StatusPageView {
    title: string;
    description: string;
    theme: UptimePageTheme;
    banner: StatusBanner;
    services: StatusServiceView[];
    ongoing: StatusIncidentView[];
    history: StatusIncidentView[];
    generatedAt: number;
}

export interface StatusViewInput {
    now: number;
    title: string;
    description: string;
    theme: UptimePageTheme;
    showErrors: boolean;
    showLatency: boolean;
    /**
     * Dans l'ordre de la page, chacun sous son nom public. `planPaused` : l'offre
     * de son propriétaire le tient en pause, il se montre comme une pause choisie.
     */
    services: readonly { row: UptimeServiceRow; name: string; planPaused?: boolean }[];
    daily: readonly UptimeDayRow[];
    /** `error` déchiffré seulement quand la page montre la nature des pannes. */
    incidents: readonly { row: UptimeIncidentRow; error: string | null }[];
    latency: readonly UptimeHourLatencyRow[];
}

function stateOf(row: UptimeServiceRow, planPaused: boolean): ServiceState {
    if (row.enabled !== 1 || planPaused) return 'paused';
    if (row.status === 'down') return 'down';
    return row.status === 'up' ? 'up' : 'pending';
}

/** Ce qu'une panne recouvre de `[from, to)`, en secondes. */
function overlap(incident: UptimeIncidentRow, from: number, to: number, now: number): number {
    const end = Math.min(incident.ended_at ?? now, to);
    return Math.max(0, end - Math.max(incident.started_at, from));
}

function barsOf(
    days: ReadonlyMap<number, UptimeDayRow>,
    incidents: readonly UptimeIncidentRow[],
    firstDay: number,
    now: number
): StatusBar[] {
    return Array.from({ length: UPTIME_PAGE_DAYS }, (_, i) => {
        const day = firstDay + i * DAY;
        const row = days.get(day);
        const checks = Number(row?.checks ?? 0);
        const upChecks = Number(row?.up_checks ?? 0);
        const downSeconds = incidents.reduce((total, incident) => total + overlap(incident, day, day + DAY, now), 0);
        const tone: BarTone = downSeconds > 0 ? 'down' : checks === 0 ? 'empty' : upChecks < checks ? 'degraded' : 'up';
        return { day, tone, ratio: checks > 0 ? upChecks / checks : null, downSeconds };
    });
}

function latencyOf(rows: readonly UptimeHourLatencyRow[], firstHour: number): StatusServiceView['latency'] {
    const byHour = new Map(rows.map((row) => [Number(row.at), row]));
    let total = 0;
    let samples = 0;
    const points = Array.from({ length: LATENCY_HOURS }, (_, i) => {
        const row = byHour.get(firstHour + i * HOUR);
        const n = Number(row?.samples ?? 0);
        if (!row || n === 0) return null;
        total += Number(row.total_ms);
        samples += n;
        return Math.round(Number(row.total_ms) / n);
    });
    return { points, avgMs: samples > 0 ? Math.round(total / samples) : null };
}

function bannerOf(services: readonly StatusServiceView[]): StatusBanner {
    const watched = services.filter((service) => service.state !== 'paused');
    const down = watched.filter((service) => service.state === 'down').length;
    if (down > 0) return { tone: 'down', down, watched: watched.length };
    if (watched.length === 0) return { tone: 'paused', down: 0, watched: 0 };
    const pending = watched.some((service) => service.state === 'pending');
    return { tone: pending ? 'pending' : 'up', down: 0, watched: watched.length };
}

export function buildStatusView(input: StatusViewInput): StatusPageView {
    const today = Math.floor(input.now / DAY) * DAY;
    const firstDay = today - (UPTIME_PAGE_DAYS - 1) * DAY;
    const firstHour = Math.floor(input.now / HOUR) * HOUR - (LATENCY_HOURS - 1) * HOUR;
    const names = new Map(input.services.map(({ row, name }) => [row.id, name]));

    const services = input.services.map(({ row, name, planPaused = false }): StatusServiceView => {
        const days = new Map(input.daily.filter((d) => Number(d.service_id) === row.id).map((d) => [Number(d.day), d]));
        const incidents = input.incidents.filter((i) => i.row.service_id === row.id).map((i) => i.row);
        const inWindow = [...days.values()].filter((d) => Number(d.day) >= firstDay);
        const checks = inWindow.reduce((total, d) => total + Number(d.checks), 0);
        const upChecks = inWindow.reduce((total, d) => total + Number(d.up_checks), 0);
        const state = stateOf(row, planPaused);
        return {
            name,
            state,
            intervalSeconds: state === 'paused' ? null : Number(row.interval_seconds),
            bars: barsOf(days, incidents, firstDay, input.now),
            ratio: checks > 0 ? upChecks / checks : null,
            latency: input.showLatency
                ? latencyOf(
                      input.latency.filter((l) => Number(l.service_id) === row.id),
                      firstHour
                  )
                : null
        };
    });

    const incidentView = ({ row, error }: StatusViewInput['incidents'][number]): StatusIncidentView => ({
        service: names.get(row.service_id) ?? '',
        startedAt: row.started_at,
        endedAt: row.ended_at,
        reason: input.showErrors ? publicReason(row.http_status, error) : null
    });
    const historyFrom = input.now - HISTORY_DAYS * DAY;

    return {
        title: input.title,
        description: input.description,
        theme: input.theme,
        banner: bannerOf(services),
        services,
        ongoing: input.incidents.filter((i) => i.row.ended_at === null).map(incidentView),
        history: input.incidents
            .filter((i) => i.row.ended_at !== null && i.row.ended_at >= historyFrom)
            .sort((a, b) => b.row.started_at - a.row.started_at)
            .slice(0, HISTORY_MAX)
            .map(incidentView),
        generatedAt: input.now
    };
}
