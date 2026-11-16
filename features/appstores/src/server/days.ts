/**
 * Les jours du module : comptés depuis 1970 en UTC, comme en base, et rendus
 * aux contrats en secondes epoch (minuit UTC). Un jour de store est une date
 * civile, quel que soit le fuseau dans lequel le store l'a arrêtée.
 */

export const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;

/** Le jour d'une date civile, ou `null` pour une date qui n'existe pas. */
export function dayOfDate(year: number, month: number, day: number): number | null {
    if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const ms = Date.UTC(year, month - 1, day);
    const back = new Date(ms);
    if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
    return ms / DAY_MS;
}

export function dayOfSeconds(seconds: number): number {
    return Math.floor(seconds / DAY_SECONDS);
}

export function utcToday(nowMs: number): number {
    return Math.floor(nowMs / DAY_MS);
}

/** `2026-11-14`. */
export function isoDay(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** La date civile d'un jour. */
export function civilOf(day: number): { year: number; month: number; day: number } {
    const date = new Date(day * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Le mois d'un jour, tel que les rapports de Google Play le nomment : `202611`. */
export function monthOf(day: number): string {
    return isoDay(day).slice(0, 7).replace('-', '');
}

/** Le premier et le dernier jour d'un mois `AAAAMM`. */
export function monthBounds(month: string): { from: number; to: number } {
    const year = Number(month.slice(0, 4));
    const index = Number(month.slice(4, 6)) - 1;
    return { from: Date.UTC(year, index, 1) / DAY_MS, to: Date.UTC(year, index + 1, 1) / DAY_MS - 1 };
}

/** Les mois de `fromDay` à `toDay`, du plus récent au plus ancien. */
export function monthsDescending(fromDay: number, toDay: number): string[] {
    const out: string[] = [];
    let day = toDay;
    while (day >= fromDay) {
        const month = monthOf(day);
        out.push(month);
        day = monthBounds(month).from - 1;
    }
    return out;
}

const PACIFIC = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

/** Aujourd'hui à l'heure du Pacifique, où Apple arrête ses journées de ventes. */
export function pacificToday(nowMs: number): number {
    const parts = PACIFIC.formatToParts(new Date(nowMs));
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return dayOfDate(part('year'), part('month'), part('day')) ?? utcToday(nowMs);
}
