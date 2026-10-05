/**
 * Lever et coucher du soleil, calculés sur place par l'équation du lever du
 * soleil (à la minute près sous les latitudes habitées). Aucun service : la
 * position ne quitte pas l'appareil.
 */

export interface Position {
    lat: number;
    lon: number;
}

/** Un jour : ses deux bornes, ou ce que fait le soleil quand il n'en a pas. */
export type SunDay = { rise: number; set: number } | { polar: 'day' | 'night' };

const DAY_MS = 86_400_000;
const J2000 = 2451545;
const rad = Math.PI / 180;

function toJulian(ms: number): number {
    return ms / DAY_MS + 2440587.5;
}

function fromJulian(j: number): number {
    return (j - 2440587.5) * DAY_MS;
}

/** Le jour solaire dont le midi tombe le plus près de `ms`, à cette longitude. */
export function sunDay(ms: number, { lat, lon }: Position): SunDay {
    const n = Math.round(toJulian(ms) - J2000 - 0.0009 + lon / 360);
    const meanNoon = n + 0.0009 - lon / 360;
    const m = (357.5291 + 0.98560028 * meanNoon) * rad;
    const center = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
    const lambda = m + (center + 180 + 102.9372) * rad;
    const transit = J2000 + meanNoon + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * lambda);
    const sinDecl = Math.sin(lambda) * Math.sin(23.4397 * rad);
    const cosDecl = Math.cos(Math.asin(sinDecl));
    const phi = lat * rad;
    // -0,833° : le centre du disque sous l'horizon quand son bord le touche.
    const cosHour = (Math.sin(-0.833 * rad) - Math.sin(phi) * sinDecl) / (Math.cos(phi) * cosDecl);
    if (cosHour > 1) return { polar: 'night' };
    if (cosHour < -1) return { polar: 'day' };
    const half = Math.acos(cosHour) / (2 * Math.PI);
    return { rise: fromJulian(transit - half), set: fromJulian(transit + half) };
}

/**
 * Le soleil est-il levé à `ms`, et jusqu'à quand cela tient-il. La veille compte
 * aussi : sous un été nordique, le coucher d'hier tombe après minuit.
 */
export function daylightAt(ms: number, pos: Position): { light: boolean; until: number | null } {
    const days = [-1, 0, 1, 2].map((d) => sunDay(ms + d * DAY_MS, pos));
    const today = days[1];
    let light: boolean;
    if ('polar' in today) light = today.polar === 'day';
    else {
        const yesterday = days[0];
        light = (ms >= today.rise && ms < today.set) || (!('polar' in yesterday) && ms < yesterday.set);
    }
    const bounds = days
        .flatMap((d) => ('polar' in d ? [] : [d.rise, d.set]))
        .filter((t) => t > ms)
        .sort((a, b) => a - b);
    return { light, until: bounds[0] ?? null };
}

/**
 * Une position tirée du seul fuseau, quand le navigateur n'en donne pas : la
 * longitude de l'heure légale d'hiver, et l'hémisphère que trahit le mois de
 * l'heure d'été. L'erreur se compte en dizaines de minutes, pas en heures.
 */
export function positionFromTimezone(now = new Date()): Position {
    const year = now.getFullYear();
    const jan = -new Date(year, 0, 1).getTimezoneOffset();
    const jul = -new Date(year, 6, 1).getTimezoneOffset();
    const lon = (Math.min(jan, jul) / 60) * 15;
    const lat = jan === jul ? 30 : jul > jan ? 45 : -35;
    return { lat, lon: Math.max(-180, Math.min(180, lon)) };
}
