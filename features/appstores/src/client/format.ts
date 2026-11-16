import type { AppStore, AppStoresCapability, AppStoresRange, AppStoresResolution } from '../contracts/domain';

export const STORE_LABELS: Record<AppStore, string> = { apple: 'App Store', google: 'Google Play' };

/** Le logo d'un store, classe d'icône sans son préfixe `icon-`. */
export const STORE_ICONS: Record<AppStore, string> = { apple: 'apple', google: 'google-play' };

/** Le store dans une phrase : « sur l’App Store », « sur Google Play ». */
export const ON_STORE: Record<AppStore, string> = { apple: 'sur l’App Store', google: 'sur Google Play' };

/** Celui qui tient le store : « chez Apple ». */
export const STORE_VENDORS: Record<AppStore, string> = { apple: 'Apple', google: 'Google' };

/** La console où l'utilisateur crée la clé et règle les accès. */
export const STORE_CONSOLES: Record<AppStore, string> = { apple: 'App Store Connect', google: 'Play Console' };

export const STORE_ORDER: readonly AppStore[] = ['apple', 'google'];

export const RANGES: readonly AppStoresRange[] = ['7d', '30d', '90d', '365d'];
export const DEFAULT_RANGE: AppStoresRange = '30d';

export const RANGE_LABELS: Record<AppStoresRange, string> = {
    '7d': '7 j',
    '30d': '30 j',
    '90d': '90 j',
    '365d': '365 j'
};

export const RANGE_TITLES: Record<AppStoresRange, string> = {
    '7d': 'Les 7 derniers jours relevés',
    '30d': 'Les 30 derniers jours relevés',
    '90d': 'Les 90 derniers jours relevés',
    '365d': 'Les 365 derniers jours relevés'
};

/** Une valeur absente : le tiret court des autres fonctionnalités, jamais un zéro inventé. */
export const MISSING = '–';

export function formatCount(value: number): string {
    return value.toLocaleString('fr-FR');
}

/** « 0 projet », « 3 projets » : le singulier va jusqu'à un, comme en français. */
export function plural(count: number, one: string, many: string): string {
    return `${formatCount(count)} ${count > 1 ? many : one}`;
}

/** « 4,6 » : une note se lit au dixième. */
export function formatRating(value: number): string {
    return value.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** « 1,09 % » : les seuils de Google sont au centième, le taux se lit à la même échelle. */
export function formatRate(ratio: number): string {
    return `${(ratio * 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

/** `null` quand la période d'avant est à zéro : « +100 % » sur une app qui démarre serait inventé. */
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

/** « +0,2 », « −0,1 » : une note varie en dixièmes, pas en pour cent. */
export function formatRatingDelta(value: number): string {
    const tenths = Math.round(value * 10);
    if (tenths === 0) return '±0';
    return tenths > 0 ? `+${formatRating(tenths / 10)}` : `−${formatRating(Math.abs(tenths) / 10)}`;
}

/** Un code que le navigateur ne connaît pas fait lever `Intl` : le montant reste lisible. */
export function formatMoney(amount: number, currency: string): string {
    try {
        return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount);
    } catch {
        return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} ${currency}`;
    }
}

/** « Euro », « Dollar des États-Unis » ; le code tel quel si le navigateur ne le nomme pas. */
export function currencyName(code: string): string {
    try {
        const name = new Intl.DisplayNames(['fr'], { type: 'currency' }).of(code);
        return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
    } catch {
        return code;
    }
}

const UTC_DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', timeZone: 'UTC' };

/** « 14 novembre » : un jour de store, minuit UTC, lu en UTC pour ne pas glisser d'un jour. */
export function formatDay(epochSeconds: number): string {
    const date = new Date(epochSeconds * 1000);
    const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
    return date.toLocaleDateString('fr-FR', sameYear ? UTC_DAY : { ...UTC_DAY, year: 'numeric' });
}

/** « 14 nov. 2026 » : la date d'un avis ou d'une réponse, à l'heure de celui qui lit. */
export function formatDate(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

/** « il y a 4 h » : la fraîcheur d'une synchronisation, pas sa date exacte. */
export function formatAgo(epochSeconds: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/** L'étiquette d'une colonne de courbe : le jour et le mois, sans l'année. */
export function formatPointLabel(at: number): string {
    return new Date(at * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Le titre complet d'une colonne, celui qu'on lit au survol. */
export function formatPointTitle(at: number, resolution: AppStoresResolution): string {
    const date = new Date(at * 1000);
    if (resolution === 'week') return `semaine du ${date.toLocaleDateString('fr-FR', UTC_DAY)}`;
    return date.toLocaleDateString('fr-FR', { ...UTC_DAY, weekday: 'long' });
}

/**
 * Les débuts de seau de la fenêtre, tous : le serveur ne rend que les seaux
 * relevés. Un point au-delà de `to` prolonge l'axe plutôt que de disparaître.
 */
export function bucketStarts(from: number, to: number, bucket: number, ats: readonly number[]): number[] {
    const end = Math.max(to, ...ats.map((at) => at + bucket));
    const starts: number[] = [];
    for (let at = from; at < end; at += bucket) starts.push(at);
    return starts;
}

/**
 * Un seau sans ligne en base : avant le dernier jour relevé, c'est un jour
 * sans activité ; après, un jour que le store n'a pas encore publié.
 */
export function absentValue(at: number, dataUntil: number | null): number | null {
    return dataUntil !== null && at <= dataUntil ? 0 : null;
}

/** « a », « a et b », « a, b et c ». */
export function joinFr(items: readonly string[]): string {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/** Les tons que `StatusBadge` comprend, sans en importer le type. */
export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

const VERSION_STATES: Record<string, { label: string; tone: Tone }> = {
    WAITING_FOR_REVIEW: { label: 'En attente de revue', tone: 'accent' },
    IN_REVIEW: { label: 'En revue', tone: 'accent' },
    PENDING_DEVELOPER_RELEASE: { label: 'Acceptée, à publier', tone: 'warning' },
    PENDING_APPLE_RELEASE: { label: 'Acceptée, publication par Apple', tone: 'accent' },
    READY_FOR_DISTRIBUTION: { label: 'En vente', tone: 'success' },
    REJECTED: { label: 'Rejetée', tone: 'danger' },
    METADATA_REJECTED: { label: 'Métadonnées rejetées', tone: 'danger' },
    DEVELOPER_REJECTED: { label: 'Retirée de la revue', tone: 'neutral' },
    PREPARE_FOR_SUBMISSION: { label: 'En préparation', tone: 'neutral' },
    PROCESSING_FOR_DISTRIBUTION: { label: 'Publication en cours', tone: 'accent' },
    READY_FOR_REVIEW: { label: 'Prête pour la revue', tone: 'neutral' },
    INVALID_BINARY: { label: 'Binaire refusé', tone: 'danger' },
    WAITING_FOR_EXPORT_COMPLIANCE: { label: 'Conformité export à déclarer', tone: 'warning' },
    ACCEPTED: { label: 'Acceptée', tone: 'success' },
    REPLACED_WITH_NEW_VERSION: { label: 'Remplacée', tone: 'neutral' }
};

/** Un état qu'Apple ajouterait demain se montre brut plutôt que de disparaître. */
export function versionState(state: string): { label: string; tone: Tone } {
    return VERSION_STATES[state] ?? { label: state, tone: 'neutral' };
}

export const CAPABILITY_LABELS: Record<AppStoresCapability, string> = {
    apps: 'Liste des apps',
    downloads: 'Téléchargements',
    ratings: 'Notes',
    reviews: 'Avis',
    revenue: 'Revenus',
    versions: 'Versions',
    vitals: 'Stabilité'
};

/** Le complément d'une phrase : « ne lit pas les avis ». */
export const CAPABILITY_OBJECTS: Record<AppStoresCapability, string> = {
    apps: 'la liste des apps',
    downloads: 'les téléchargements',
    ratings: 'les notes',
    reviews: 'les avis',
    revenue: 'les revenus',
    versions: 'les versions',
    vitals: 'la stabilité'
};

/** Apple ne mesure pas la stabilité, et l'état des versions Google n'est pas lu. */
export const STORE_CAPABILITIES: Record<AppStore, readonly AppStoresCapability[]> = {
    apple: ['apps', 'downloads', 'ratings', 'reviews', 'revenue', 'versions'],
    google: ['apps', 'downloads', 'ratings', 'reviews', 'revenue', 'vitals']
};

/** Ce qu'il manque à une clé pour lire une capacité, avec les mots de la console du store. */
export const CAPABILITY_NEEDS: Record<AppStore, Partial<Record<AppStoresCapability, string>>> = {
    apple: {
        apps: 'La clé ne voit aucune app : vérifiez dans App Store Connect qu’elle n’a pas été révoquée.',
        downloads:
            'Il faut une clé qui accède aux rapports de ventes, comme une clé Admin, et le bon numéro de fournisseur.',
        ratings: 'La note publique de l’App Store n’a pas pu être lue : refaites le test un peu plus tard.',
        reviews: 'Il faut une clé qui lit les avis, comme une clé Admin.',
        revenue:
            'Il faut une clé qui accède aux rapports de ventes, comme une clé Admin, et le bon numéro de fournisseur.',
        versions: 'Il faut une clé qui voit les versions de l’app, comme une clé Admin.'
    },
    google: {
        apps: 'Le compte de service ne voit aucune app : invitez son adresse dans la Play Console (étape 2). Une invitation peut mettre jusqu’à 24 h à prendre effet.',
        downloads:
            'Il faut l’autorisation « Voir les informations sur les applications et télécharger les rapports groupés », et la bonne URI des rapports (étape 3).',
        ratings:
            'Comme pour les téléchargements : l’autorisation des rapports groupés, et la bonne URI des rapports (étape 3).',
        reviews: 'Il faut l’autorisation « Répondre aux avis ».',
        revenue: 'Il faut l’autorisation « Voir les données financières ».',
        vitals: 'Il faut l’autorisation « Voir les informations sur la qualité de l’application », et l’API Google Play Developer Reporting activée (étape 1).'
    }
};

/**
 * Les pays de l'App Store : le code à deux lettres de la note, puis celui à
 * trois lettres qu'Apple donne aux avis.
 */
const STOREFRONTS =
    'AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AR:ARG AT:AUT AU:AUS AZ:AZE BA:BIH BB:BRB BD:BGD BE:BEL ' +
    'BF:BFA BG:BGR BH:BHR BJ:BEN BM:BMU BN:BRN BO:BOL BR:BRA BS:BHS BT:BTN BW:BWA BY:BLR BZ:BLZ CA:CAN CD:COD ' +
    'CG:COG CH:CHE CI:CIV CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CV:CPV CY:CYP CZ:CZE DE:DEU DK:DNK DM:DMA DO:DOM ' +
    'DZ:DZA EC:ECU EE:EST EG:EGY ES:ESP FI:FIN FJ:FJI FM:FSM FR:FRA GA:GAB GB:GBR GD:GRD GE:GEO GH:GHA GM:GMB ' +
    'GR:GRC GT:GTM GW:GNB GY:GUY HK:HKG HN:HND HR:HRV HU:HUN ID:IDN IE:IRL IL:ISR IN:IND IQ:IRQ IS:ISL IT:ITA ' +
    'JM:JAM JO:JOR JP:JPN KE:KEN KG:KGZ KH:KHM KN:KNA KR:KOR KW:KWT KY:CYM KZ:KAZ LA:LAO LB:LBN LC:LCA LK:LKA ' +
    'LR:LBR LT:LTU LU:LUX LV:LVA LY:LBY MA:MAR MD:MDA ME:MNE MG:MDG MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MR:MRT ' +
    'MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI MX:MEX MY:MYS MZ:MOZ NA:NAM NE:NER NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL ' +
    'NR:NRU NZ:NZL OM:OMN PA:PAN PE:PER PG:PNG PH:PHL PK:PAK PL:POL PT:PRT PW:PLW PY:PRY QA:QAT RO:ROU RS:SRB ' +
    'RU:RUS RW:RWA SA:SAU SB:SLB SC:SYC SE:SWE SG:SGP SI:SVN SK:SVK SL:SLE SN:SEN SR:SUR ST:STP SV:SLV SZ:SWZ ' +
    'TC:TCA TD:TCD TH:THA TJ:TJK TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TW:TWN TZ:TZA UA:UKR UG:UGA US:USA UY:URY ' +
    'UZ:UZB VC:VCT VE:VEN VG:VGB VN:VNM VU:VUT XK:XKS YE:YEM ZA:ZAF ZM:ZMB ZW:ZWE';

const COUNTRY_CODES: string[] = [];
const FROM_ALPHA3 = new Map<string, string>();
for (const pair of STOREFRONTS.split(' ')) {
    const [two, three] = pair.split(':');
    COUNTRY_CODES.push(two);
    FROM_ALPHA3.set(three, two);
}

let regions: Intl.DisplayNames | null | undefined;

/** « France » pour `FR` comme pour `FRA` ; le code tel quel si le navigateur ne le nomme pas. */
export function countryName(code: string): string {
    const upper = code.toUpperCase();
    const two = upper.length === 3 ? (FROM_ALPHA3.get(upper) ?? null) : upper;
    if (two === null) return upper;
    if (regions === undefined) {
        try {
            regions = new Intl.DisplayNames(['fr'], { type: 'region' });
        } catch {
            regions = null;
        }
    }
    try {
        return regions?.of(two) ?? two;
    } catch {
        return two;
    }
}

/** Les pays où lire la note App Store, par nom ; le pays en place reste choisissable même hors liste. */
export function countryOptions(current: string): { value: string; label: string; detail: string }[] {
    const codes = COUNTRY_CODES.includes(current) || current === '' ? COUNTRY_CODES : [...COUNTRY_CODES, current];
    return codes
        .map((code) => ({ value: code, label: countryName(code), detail: code }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}
