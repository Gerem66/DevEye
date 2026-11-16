import { APPSTORES_ANR_THRESHOLD, APPSTORES_CRASH_THRESHOLD, type AppStore } from '../contracts/domain';
import type { SdkAlert } from '@deveye/types/sdk/server';

// L'horodatage des corps d'alerte est celui de tous les émetteurs de l'app : importé, pas recopié.
import { formatMoment } from '@/Services/alertCore';
// Les helpers Discord partagés par tous les émetteurs de l'app : importés, pas recopiés.
import {
    COLOR_DANGER,
    COLOR_INFO,
    COLOR_SUCCESS,
    COLOR_WARNING,
    footer,
    moment,
    trim
} from '@/Services/notices/shared';

/**
 * Les avis de Stores, en texte puis en embeds Discord, sans base ni réseau.
 * Aucun ne porte de montant : un canal d'alerte se lit sans le droit Revenus.
 */

const STORE_LABEL: Record<AppStore, string> = { apple: 'App Store', google: 'Google Play' };
const STORE_OWNER: Record<AppStore, string> = { apple: 'Apple', google: 'Google' };

/** Apps nommées dans un avis : au-delà, on compte. */
const NAMED = 5;
/** Les extraits d'avis cités, et leur longueur. */
const EXCERPTS = 3;
const EXCERPT_MAX = 160;

/** « Météo, Notes et 3 autres ». */
export function nameApps(names: readonly string[]): string {
    if (names.length === 0) return 'aucune app';
    const named = names.slice(0, NAMED);
    const rest = names.length - named.length;
    return rest === 0 ? named.join(', ') : `${named.join(', ')} et ${rest} autre${rest > 1 ? 's' : ''}`;
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count > 1 ? many : one}`;
}

function stars(rating: number): string {
    const full = Math.min(5, Math.max(0, Math.round(rating)));
    return `${'★'.repeat(full)}${'☆'.repeat(5 - full)}`;
}

function excerpt(title: string, body: string): string {
    const textOf = [title.trim(), body.trim()]
        .filter((part) => part !== '')
        .join(' : ')
        .replace(/\s+/g, ' ');
    return textOf.length <= EXCERPT_MAX ? textOf : `${textOf.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

/** « 1,32 % ». */
export function percent(rate: number): string {
    return `${(rate * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
}

// ----------------------------------------------------------------- la source

export interface SourceNotice {
    lost: boolean;
    store: AppStore;
    label: string;
    apps: readonly string[];
    /** Notre phrase, jamais celle du store. */
    cause: string;
    at: number;
}

/** La clé d'une source refusée, ou de nouveau acceptée : un avis par source, vers les canaux de ses apps. */
export function sourceNotice(notice: SourceNotice): SdkAlert {
    const who = STORE_OWNER[notice.store];
    const count = plural(notice.apps.length, 'app', 'apps');
    const lead = notice.lost
        ? `${who} refuse la clé « ${notice.label} » : la synchronisation de ${count} est arrêtée.`
        : `${who} accepte de nouveau la clé « ${notice.label} » : la synchronisation de ${count} a repris.`;
    const lines = [
        lead,
        '',
        `Source : ${notice.label} (${STORE_LABEL[notice.store]})`,
        `Apps : ${nameApps(notice.apps)}`,
        `${notice.lost ? 'Depuis le' : 'Rétablie le'} : ${formatMoment(notice.at)}`
    ];
    if (notice.lost && notice.cause) lines.push(`Cause : ${notice.cause}`);
    if (notice.lost) lines.push('', 'Corrigez la clé dans Stores, Réglages, onglet Sources.');
    const fields: Record<string, unknown>[] = [
        { name: '🔑 Source', value: trim(`${notice.label} (${STORE_LABEL[notice.store]})`), inline: true },
        { name: notice.lost ? '📅 Depuis' : '📅 Rétablie', value: moment(notice.at), inline: true },
        { name: `📱 ${count}`, value: trim(nameApps(notice.apps)) }
    ];
    if (notice.lost && notice.cause) fields.push({ name: '📋 Cause', value: trim(notice.cause) });
    return {
        subject: notice.lost
            ? `[DevEye] Stores : la clé « ${notice.label} » est refusée`
            : `[DevEye] Stores : la clé « ${notice.label} » est de nouveau acceptée`,
        body: lines.join('\n'),
        payload: {
            event: notice.lost ? 'appstores_source_lost' : 'appstores_source_restored',
            source: notice.label,
            store: notice.store,
            apps: notice.apps,
            at: notice.at
        },
        embeds: [
            {
                title: notice.lost
                    ? `🔴 Clé « ${trim(notice.label)} » refusée`
                    : `🟢 Clé « ${trim(notice.label)} » de nouveau acceptée`,
                description: lead,
                color: notice.lost ? COLOR_DANGER : COLOR_SUCCESS,
                fields,
                timestamp: new Date(notice.at * 1000).toISOString(),
                footer: footer('Stores')
            }
        ]
    };
}

// ----------------------------------------------------------------- les avis

export interface ReviewsNotice {
    app: string;
    store: AppStore;
    reviews: readonly { rating: number; title: string; body: string; author: string }[];
    at: number;
}

/** Les avis arrivés en un passage, en un seul message : le compte, la note la plus basse, les premiers extraits. */
export function reviewsNotice(notice: ReviewsNotice): SdkAlert {
    const count = notice.reviews.length;
    const lowest = Math.min(...notice.reviews.map((r) => r.rating));
    const what = count > 1 ? `${count} nouveaux avis` : '1 nouvel avis';
    const lead = `${what} sur ${notice.app} (${STORE_LABEL[notice.store]}). ${
        count > 1
            ? `La note la plus basse : ${plural(lowest, 'étoile', 'étoiles')}.`
            : `Note : ${plural(lowest, 'étoile', 'étoiles')}.`
    }`;
    const quoted = notice.reviews.slice(0, EXCERPTS).map((review) => {
        const text = excerpt(review.title, review.body);
        return `${stars(review.rating)} ${review.author ? `${review.author} : ` : ''}${text ? `« ${text} »` : '(sans texte)'}`;
    });
    const more = count - quoted.length;
    const lines = [lead, '', ...quoted];
    if (more > 0) lines.push(`… et ${plural(more, 'autre avis', 'autres avis')}.`);
    return {
        subject: `[DevEye] ${what} sur ${notice.app}`,
        body: lines.join('\n'),
        payload: { event: 'appstores_reviews', app: notice.app, store: notice.store, count, lowest },
        embeds: [
            {
                title: `💬 ${what} sur ${trim(notice.app)}`,
                description: trim(lead),
                color: lowest <= 2 ? COLOR_WARNING : COLOR_INFO,
                fields: notice.reviews.slice(0, EXCERPTS).map((review) => ({
                    name: `${stars(review.rating)}${review.author ? ` · ${review.author}` : ''}`.slice(0, 250),
                    value: trim(excerpt(review.title, review.body) || '(sans texte)')
                })),
                timestamp: new Date(notice.at * 1000).toISOString(),
                footer: footer(`Stores · ${STORE_LABEL[notice.store]}`)
            }
        ]
    };
}

// ----------------------------------------------------------------- les versions

/** Les étapes d'une version qui valent un avis ; les autres états passent en silence. */
export type VersionPhase = 'submitted' | 'review' | 'accepted' | 'rejected' | 'live';

const PHASES: Record<string, VersionPhase> = {
    WAITING_FOR_REVIEW: 'submitted',
    READY_FOR_REVIEW: 'submitted',
    IN_REVIEW: 'review',
    ACCEPTED: 'accepted',
    PENDING_DEVELOPER_RELEASE: 'accepted',
    PENDING_APPLE_RELEASE: 'accepted',
    REJECTED: 'rejected',
    METADATA_REJECTED: 'rejected',
    INVALID_BINARY: 'rejected',
    READY_FOR_DISTRIBUTION: 'live'
};

/** La phase d'un `appVersionState` d'Apple, `null` pour un état qui ne se signale pas. */
export function phaseOf(state: string): VersionPhase | null {
    return PHASES[state] ?? null;
}

const PHASE_TITLE: Record<VersionPhase, string> = {
    submitted: 'soumise à la revue',
    review: 'en revue',
    accepted: 'acceptée',
    rejected: 'rejetée',
    live: 'en vente'
};

const PHASE_SENTENCE: Record<VersionPhase, string> = {
    submitted: 'attend la revue d’Apple',
    review: 'est en revue chez Apple',
    accepted: 'a été acceptée par Apple',
    rejected: 'a été rejetée par Apple : le motif se lit dans App Store Connect',
    live: 'est en vente sur l’App Store'
};

export interface VersionNotice {
    app: string;
    version: string;
    phase: VersionPhase;
    at: number;
}

export function versionNotice(notice: VersionNotice): SdkAlert {
    const sentence = `La version ${notice.version} de ${notice.app} ${PHASE_SENTENCE[notice.phase]}.`;
    const color = notice.phase === 'rejected' ? COLOR_DANGER : notice.phase === 'live' ? COLOR_SUCCESS : COLOR_INFO;
    return {
        subject: `[DevEye] ${notice.app} ${notice.version} : ${PHASE_TITLE[notice.phase]}`,
        body: [sentence, '', `Le : ${formatMoment(notice.at)}`].join('\n'),
        payload: { event: 'appstores_version', app: notice.app, version: notice.version, phase: notice.phase },
        embeds: [
            {
                title: `🍏 ${trim(notice.app)} ${trim(notice.version)} : ${PHASE_TITLE[notice.phase]}`,
                description: sentence,
                color,
                timestamp: new Date(notice.at * 1000).toISOString(),
                footer: footer('Stores · App Store')
            }
        ]
    };
}

// ----------------------------------------------------------------- la stabilité

export interface VitalsNotice {
    app: string;
    metric: 'crash' | 'anr';
    /** Au-dessus du seuil, ou repassé dessous. */
    over: boolean;
    rate: number;
    at: number;
}

const METRIC_LABEL = { crash: 'Le taux de plantages perçus', anr: 'Le taux d’ANR perçus (l’app ne répond plus)' };
const METRIC_SHORT = { crash: 'plantages', anr: 'ANR' };

/** Le taux sur 28 jours, pondéré par utilisateurs, a franchi le seuil de Google dans un sens ou dans l'autre. */
export function vitalsNotice(notice: VitalsNotice): SdkAlert {
    const threshold = notice.metric === 'crash' ? APPSTORES_CRASH_THRESHOLD : APPSTORES_ANR_THRESHOLD;
    const sentence = notice.over
        ? `${METRIC_LABEL[notice.metric]} de ${notice.app} sur 28 jours atteint ${percent(notice.rate)}, au-dessus du seuil de ${percent(threshold)} au-delà duquel Google Play peut réduire la visibilité de l’app.`
        : `${METRIC_LABEL[notice.metric]} de ${notice.app} sur 28 jours est redescendu à ${percent(notice.rate)}, sous le seuil de ${percent(threshold)} de Google Play.`;
    return {
        subject: notice.over
            ? `[DevEye] ${notice.app} : ${METRIC_SHORT[notice.metric]} au-dessus du seuil de Google Play`
            : `[DevEye] ${notice.app} : ${METRIC_SHORT[notice.metric]} repassés sous le seuil de Google Play`,
        body: sentence,
        payload: {
            event: 'appstores_vitals',
            app: notice.app,
            metric: notice.metric,
            over: notice.over,
            rate: notice.rate,
            threshold
        },
        embeds: [
            {
                title: notice.over
                    ? `🟠 ${trim(notice.app)} : ${METRIC_SHORT[notice.metric]} au-dessus du seuil`
                    : `🟢 ${trim(notice.app)} : ${METRIC_SHORT[notice.metric]} sous le seuil`,
                description: sentence,
                color: notice.over ? COLOR_WARNING : COLOR_SUCCESS,
                timestamp: new Date(notice.at * 1000).toISOString(),
                footer: footer('Stores · Google Play')
            }
        ]
    };
}
