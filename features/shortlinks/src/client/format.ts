import {
    SHORTLINK_URL_MAX,
    type Shortlink,
    type ShortlinkDimension,
    type ShortlinkPoint,
    type ShortlinkRange,
    type ShortlinkStats,
    type ShortlinkUtm
} from '../contracts/domain';

export const RANGES: readonly ShortlinkRange[] = ['7d', '30d', '90d', '12m'];

export const RANGE_LABELS: Readonly<Record<ShortlinkRange, string>> = {
    '7d': '7 j',
    '30d': '30 j',
    '90d': '90 j',
    '12m': '12 mois'
};

export const RANGE_TITLES: Readonly<Record<ShortlinkRange, string>> = {
    '7d': 'Les 7 derniers jours',
    '30d': 'Les 30 derniers jours',
    '90d': 'Les 90 derniers jours',
    '12m': 'Les 12 derniers mois'
};

/** La période d'avant, de même durée : ce à quoi l'écart se compare. */
export const RANGE_BEFORE: Readonly<Record<ShortlinkRange, string>> = {
    '7d': 'les 7 jours d’avant',
    '30d': 'les 30 jours d’avant',
    '90d': 'les 90 jours d’avant',
    '12m': 'les 12 mois d’avant'
};

/** « 1 284 » : un compte se lit par tranches de mille. */
export function formatCount(value: number): string {
    return value.toLocaleString('fr-FR');
}

/** « 0 visite », « 1 visite », « 3 visites » : le français garde le singulier jusqu'à un. */
export function plural(count: number, one: string, many: string): string {
    return `${formatCount(count)} ${count > 1 ? many : one}`;
}

/** L'écart à la période d'avant ; `null` quand elle est vide, un « +100 % » y serait inventé. */
export function delta(current: number, previous: number): number | null {
    if (previous === 0) return null;
    return (current - previous) / previous;
}

/** « +18 % », « −4 % », avec le vrai signe moins. */
export function formatDelta(value: number): string {
    const percent = Math.round(value * 100);
    if (percent === 0) return '±0 %';
    return percent > 0 ? `+${percent} %` : `−${Math.abs(percent)} %`;
}

/** « 38 % » d'un total, entier. */
export function formatShare(part: number, total: number): string {
    return total > 0 ? `${Math.round((part / total) * 100)} %` : '';
}

// Les points du graphique sont des débuts de jour ou de semaine en UTC : formatés
// dans le fuseau local, ils glisseraient d'un jour à l'ouest de Greenwich.
const tickFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
});
const weekFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });

export function formatPointLabel(at: number): string {
    return tickFormat.format(new Date(at * 1000));
}

export function formatPointTitle(at: number, bucket: ShortlinkStats['bucket']): string {
    if (bucket === 'week') return `Semaine du ${weekFormat.format(new Date(at * 1000))}`;
    return capitalize(dayFormat.format(new Date(at * 1000)));
}

const BUCKET_SECONDS: Readonly<Record<ShortlinkStats['bucket'], number>> = { day: 86_400, week: 604_800 };
const BUCKET_COUNT: Readonly<Record<ShortlinkRange, number>> = { '7d': 7, '30d': 30, '90d': 90, '12m': 52 };
/** Le lundi 5 janvier 1970, premier début de semaine ISO de l'ère Unix. */
const FIRST_MONDAY = 345_600;

/**
 * La série complète de la période, jours ou semaines sans visite compris : sans
 * eux, deux jours éloignés se toucheraient et la courbe mentirait sur le rythme.
 * Une semaine s'aligne sur les points rendus par le serveur quand il y en a.
 */
export function fillSeries(stats: ShortlinkStats, now: number = Date.now() / 1000): ShortlinkPoint[] {
    const step = BUCKET_SECONDS[stats.bucket];
    const anchor = stats.bucket === 'day' ? 0 : (stats.series[0]?.at ?? FIRST_MONDAY);
    const last = anchor + Math.floor((now - anchor) / step) * step;
    const byAt = new Map(stats.series.map((point) => [point.at, point]));
    for (let index = BUCKET_COUNT[stats.range] - 1; index >= 0; index--) {
        const at = last - index * step;
        if (!byAt.has(at)) byAt.set(at, { at, clicks: 0, visits: 0 });
    }
    return [...byAt.values()].sort((a, b) => a.at - b.at);
}

/** Le nom d'hôte d'une adresse, ou l'adresse telle quelle si elle ne se lit pas. */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** L'adresse à donner : celle du domaine quand il en a une qui répond, sinon celle de DevEye. */
export function shareUrlOf(link: Pick<Shortlink, 'domainUrl' | 'shortUrl'>): string {
    return link.domainUrl ?? link.shortUrl;
}

/** Le nom d'un lien : son titre, ou l'hôte de sa destination quand il n'en a pas. */
export function displayTitle(link: Pick<Shortlink, 'title' | 'targets'>): string {
    return link.title.trim() || hostOf(link.targets.default);
}

/** Ce que le serveur accepte comme destination : une adresse web complète. */
export function isHttpUrl(value: string): boolean {
    if (value.length === 0 || value.length > SHORTLINK_URL_MAX) return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
        return false;
    }
}

export const UTM_PARAMS: Readonly<Record<keyof ShortlinkUtm, string>> = {
    source: 'utm_source',
    medium: 'utm_medium',
    campaign: 'utm_campaign',
    term: 'utm_term',
    content: 'utm_content'
};

export const UTM_KEYS = Object.keys(UTM_PARAMS) as (keyof ShortlinkUtm)[];

export function hasUtm(utm: ShortlinkUtm): boolean {
    return UTM_KEYS.some((key) => utm[key].trim().length > 0);
}

/** La destination telle que le visiteur l'atteint : les paramètres non vides remplacent ceux du même nom. */
export function withUtm(target: string, utm: ShortlinkUtm): string {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return target;
    }
    for (const key of UTM_KEYS) {
        const value = utm[key].trim();
        if (value.length > 0) url.searchParams.set(UTM_PARAMS[key], value);
    }
    return url.toString();
}

const dayFormatLocal = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const momentFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export const dayLabel = (seconds: number): string => dayFormatLocal.format(new Date(seconds * 1000));
export const momentLabel = (seconds: number): string => momentFormat.format(new Date(seconds * 1000));

/** « il y a 4 h » : la fraîcheur d'une vérification, pas sa date exacte. */
export function formatAgo(seconds: number): string {
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    if (elapsed < 60) return 'à l’instant';
    const minutes = Math.floor(elapsed / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/** Le premier du mois prochain, en UTC comme le compte des visites : « 1er novembre ». */
export function nextReset(now: Date = new Date()): string {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return next.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(/^1 /, '1er ');
}

/** Le jour d'une date de fin, au format du champ `date`, dans le fuseau de qui regarde. */
export function localDateOf(seconds: number | null): string {
    if (seconds === null) return '';
    const date = new Date(seconds * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** La fin du jour choisi, à 23 h 59 min 59 s heure locale, en secondes ; `null` si le champ ne se lit pas. */
export function endOfLocalDay(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
    const seconds = Math.floor(date.getTime() / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export const DIMENSION_TITLES: Readonly<Record<ShortlinkDimension, string>> = {
    referrer: 'Sites d’origine',
    country: 'Pays',
    device: 'Appareils',
    browser: 'Navigateurs',
    os: 'Systèmes',
    language: 'Langues'
};

export const DIMENSION_HINTS: Readonly<Record<ShortlinkDimension, string>> = {
    referrer:
        'Le site où se trouvait le lien quand on l’a suivi. Une messagerie ou un lien tapé à la main n’en donnent pas.',
    country: 'Déduit de l’adresse du visiteur au moment de la visite. L’adresse elle-même n’est pas gardée.',
    device: 'Le genre d’appareil, selon ce que le navigateur annonce.',
    browser: 'Le navigateur, selon ce qu’il annonce de lui-même.',
    os: 'Le système de l’appareil, selon ce que le navigateur annonce.',
    language: 'La langue préférée réglée dans le navigateur du visiteur.'
};

const UNKNOWN_LABELS: Readonly<Record<ShortlinkDimension, string>> = {
    referrer: 'Accès direct ou inconnu',
    country: 'Pays inconnu',
    device: 'Appareil inconnu',
    browser: 'Navigateur inconnu',
    os: 'Système inconnu',
    language: 'Langue inconnue'
};

const DEVICE_LABELS: Readonly<Record<string, string>> = {
    desktop: 'Ordinateur',
    mobile: 'Mobile',
    tablet: 'Tablette'
};

function displayNames(type: 'region' | 'language'): Intl.DisplayNames | null {
    try {
        return new Intl.DisplayNames(['fr'], { type });
    } catch {
        return null;
    }
}

const regionNames = displayNames('region');
const languageNames = displayNames('language');

function nameOf(names: Intl.DisplayNames | null, code: string): string {
    if (names === null) return code;
    try {
        return names.of(code) ?? code;
    } catch {
        // Un code que le navigateur ne connaît pas se montre tel quel.
        return code;
    }
}

function capitalize(text: string): string {
    return text.charAt(0).toLocaleUpperCase('fr-FR') + text.slice(1);
}

/** Le libellé lisible d'une ligne de classement : pays et langues nommés, vide dit « inconnu ». */
export function rowLabel(dimension: ShortlinkDimension, label: string): string {
    if (label.length === 0) return UNKNOWN_LABELS[dimension];
    if (dimension === 'country') return nameOf(regionNames, label.toUpperCase());
    if (dimension === 'language') return capitalize(nameOf(languageNames, label));
    if (dimension === 'device') return DEVICE_LABELS[label] ?? label;
    return label;
}
