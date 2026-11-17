import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

import { GOOGLE_BUCKET, GOOGLE_PACKAGE, type AppStoresCapability } from '../../contracts/domain';
import { FeatureError } from '@deveye/types/sdk/server';

import { civilOf, dayOfDate } from '../days';
import { cell, columnIndex, decodeText, parseCount, parseCsv, parseDay, parseDecimal } from '../parse/csv';
import { GOOGLE_TOKEN_URL, OAuthTokenError, postToken } from './oauth';
import {
    readBody,
    readStoreJson,
    storeCall,
    StoreError,
    type StoreApp,
    type StoreReply,
    type StoreReview
} from './types';

/**
 * Google Play, avec le compte de service que l'utilisateur invite dans sa
 * Play Console : un jeton RS256 échangé chez Google, les rapports mensuels du
 * bucket `pubsite_prod_…` pour les installations, les notes et les ventes, la
 * Reporting API pour les apps et la stabilité, l'API Publisher pour les avis.
 */

const STORAGE = 'https://storage.googleapis.com/storage/v1/b';
const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1';
const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

const SCOPES = [
    'https://www.googleapis.com/auth/androidpublisher',
    'https://www.googleapis.com/auth/playdeveloperreporting',
    'https://www.googleapis.com/auth/devstorage.read_only'
];

const TOKEN_MARGIN_MS = 60_000;
const CACHE_MAX = 500;
const OBJECT_PAGES = 20;
const APPS_PAGES = 10;
const REVIEW_PAGES = 20;
/** Un avis Google a un identifiant opaque (`gp:AOqp…`), échappé avant d'entrer dans une URL. */
const REVIEW_ID = /^[\w:.-]{1,200}$/;
/** Les métriques de stabilité quotidiennes ne se lisent que dans ce fuseau. */
const VITALS_ZONE = 'America/Los_Angeles';

export interface GoogleCredentials {
    clientEmail: string;
    /** La clé privée du compte de service, en PEM. */
    privateKey: string;
    privateKeyId: string | null;
    bucket: string;
}

export interface ServiceAccount {
    clientEmail: string;
    privateKey: string;
    privateKeyId: string | null;
}

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

const KEYS = new Map<string, KeyObject>();
const TOKENS = new Map<string, { token: string; expiresAt: number }>();

/** Les caches de clés et de jetons, vidés entre deux tests. */
export function forgetGoogleTokens(): void {
    KEYS.clear();
    TOKENS.clear();
}

const invalid = (message: string): FeatureError => new FeatureError('validation', message);

/**
 * Le JSON d'un compte de service, tel que Google Cloud le fait télécharger. On
 * n'en garde que l'adresse, la clé et son identifiant : le `token_uri` qu'il
 * porte n'est jamais lu, les jetons s'échangent à l'adresse écrite ici.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        throw invalid('Ce texte n’est pas un fichier JSON : collez le contenu entier du fichier téléchargé.');
    }
    const fields = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
    if (fields.type !== 'service_account') {
        throw invalid('Ce JSON n’est pas celui d’un compte de service Google : son champ « type » vaut autre chose.');
    }
    const clientEmail = fields.client_email;
    if (
        typeof clientEmail !== 'string' ||
        clientEmail.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)
    ) {
        throw invalid('Le JSON du compte de service ne porte pas son adresse (« client_email ») : il est incomplet.');
    }
    if (typeof fields.private_key !== 'string') {
        throw invalid('Le JSON du compte de service ne porte pas sa clé privée : il est incomplet.');
    }
    const privateKey = fields.private_key.replace(/\\n/g, '\n').trim();
    let key: KeyObject;
    try {
        key = createPrivateKey(privateKey);
    } catch {
        throw invalid('La clé privée de ce JSON ne se lit pas : téléchargez-en une nouvelle dans Google Cloud.');
    }
    if (key.asymmetricKeyType !== 'rsa') {
        throw invalid('La clé privée de ce JSON n’est pas une clé RSA de compte de service.');
    }
    const id = fields.private_key_id;
    return {
        clientEmail,
        privateKey,
        privateKeyId: typeof id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(id) ? id : null
    };
}

function keyOf(pem: string): KeyObject {
    const ref = sha256(pem);
    let key = KEYS.get(ref);
    if (!key) {
        key = createPrivateKey(pem);
        remember(KEYS, ref, key);
    }
    return key;
}

/** L'assertion signée RS256 qu'échange le point de jetons de Google. */
export function serviceAssertion(
    creds: Pick<GoogleCredentials, 'clientEmail' | 'privateKey' | 'privateKeyId'>,
    nowMs: number
): string {
    const iat = Math.floor(nowMs / 1000);
    const head = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(creds.privateKeyId ? { kid: creds.privateKeyId } : {}) })
    ).toString('base64url');
    const claims = Buffer.from(
        JSON.stringify({ iss: creds.clientEmail, scope: SCOPES.join(' '), aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })
    ).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${head}.${claims}`), keyOf(creds.privateKey)).toString('base64url');
    return `${head}.${claims}.${signature}`;
}

function tokenRef(creds: GoogleCredentials): string {
    return sha256(`${creds.clientEmail}|${creds.privateKey}`);
}

/** Le jeton d'accès d'un compte de service, gardé jusqu'à une minute de sa fin. */
export async function googleToken(
    creds: GoogleCredentials,
    signal?: AbortSignal,
    nowMs: number = Date.now()
): Promise<string> {
    const ref = tokenRef(creds);
    const cached = TOKENS.get(ref);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > nowMs) return cached.token;
    let json;
    try {
        json = await postToken(
            new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: serviceAssertion(creds, nowMs)
            }),
            signal
        );
    } catch (e) {
        if (!(e instanceof OAuthTokenError)) throw e;
        if (e.permanent) {
            throw new StoreError('google', 401, {
                message: 'Google refuse ce compte de service : sa clé a pu être supprimée, ou le compte désactivé.',
                detail: e.message
            });
        }
        const status = e.code === 'rate_limit_exceeded' ? 429 : (e.status ?? 0);
        throw new StoreError('google', status, { detail: e.message, cause: e });
    }
    const seconds = Number(json.expires_in);
    const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
    remember(TOKENS, ref, { token: json.access_token, expiresAt: nowMs + ttl * 1000 });
    return json.access_token;
}

interface ApiInit {
    method?: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
}

/** Un appel authentifié ; un 401 sur un jeton gardé en cache le renouvelle une fois. */
async function googleApi(
    creds: GoogleCredentials,
    url: string,
    init: ApiInit = {},
    expected: readonly number[] = []
): Promise<Response> {
    const call = async (token: string) =>
        storeCall(
            'google',
            url,
            {
                method: init.method ?? 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                signal: init.signal
            },
            expected
        );
    try {
        return await call(await googleToken(creds, init.signal));
    } catch (e) {
        if (!(e instanceof StoreError) || e.status !== 401) throw e;
        TOKENS.delete(tokenRef(creds));
        return call(await googleToken(creds, init.signal));
    }
}

function bucketOf(creds: GoogleCredentials): string {
    if (!GOOGLE_BUCKET.test(creds.bucket)) throw new Error('Bucket Google Play invalide');
    return creds.bucket;
}

function assertPackage(pkg: string): string {
    if (!GOOGLE_PACKAGE.test(pkg) || pkg.length > 255) throw new Error('Nom de paquet invalide');
    return pkg;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Des secondes epoch telles que les API de Google les écrivent (`{ seconds: "1700000000" }`). */
function secondsOf(value: unknown): number | null {
    const raw = (value as { seconds?: unknown } | null | undefined)?.seconds;
    const seconds = Number(raw);
    return raw === undefined || !Number.isFinite(seconds) ? null : Math.trunc(seconds);
}

// ----------------------------------------------------------------- le bucket

export interface StoredObject {
    name: string;
    etag: string;
}

/** Les objets du bucket sous un préfixe. `limit` borne la lecture, pour une sonde. */
export async function listObjects(
    creds: GoogleCredentials,
    prefix: string,
    signal?: AbortSignal,
    limit?: number
): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < OBJECT_PAGES; page++) {
        const query = new URLSearchParams({
            prefix,
            fields: 'items(name,etag),nextPageToken',
            maxResults: String(limit ?? 1000)
        });
        if (pageToken) query.set('pageToken', pageToken);
        const doc = await readStoreJson<{ items?: { name?: unknown; etag?: unknown }[]; nextPageToken?: unknown }>(
            'google',
            await googleApi(creds, `${STORAGE}/${bucketOf(creds)}/o?${query.toString()}`, { signal })
        );
        for (const item of doc.items ?? []) {
            if (typeof item.name === 'string') out.push({ name: item.name, etag: text(item.etag) ?? '' });
        }
        pageToken = text(doc.nextPageToken);
        if (pageToken === null || limit !== undefined) break;
    }
    return out;
}

/** Les octets d'un objet du bucket ; le nom est échappé, le bucket ne va jamais dans le nom d'hôte. */
export async function downloadObject(
    creds: GoogleCredentials,
    name: string,
    maxBytes: number,
    signal?: AbortSignal
): Promise<Buffer> {
    const url = `${STORAGE}/${bucketOf(creds)}/o/${encodeURIComponent(name)}?alt=media`;
    return readBody('google', await googleApi(creds, url, { signal }), maxBytes);
}

async function headObject(creds: GoogleCredentials, name: string, signal?: AbortSignal): Promise<void> {
    const url = `${STORAGE}/${bucketOf(creds)}/o/${encodeURIComponent(name)}?fields=name`;
    const res = await googleApi(creds, url, { signal });
    await res.body?.cancel().catch(() => undefined);
}

/** Le rapport mensuel des installations d'un paquet, tel que la Play Console le range. */
export function installsObject(pkg: string, month: string): string {
    return `stats/installs/installs_${assertPackage(pkg)}_${month}_overview.csv`;
}

export function ratingsObject(pkg: string, month: string): string {
    return `stats/ratings/ratings_${assertPackage(pkg)}_${month}_overview.csv`;
}

export function salesObject(month: string): string {
    return `sales/salesreport_${month}.zip`;
}

const INSTALLS_NAME = /^stats\/installs\/installs_(.+)_(\d{6})_overview\.csv$/;
/** Un rapport d'installations de n'importe quelle dimension (`app_version`, `country`…) : le premier venu n'est pas l'aperçu. */
const INSTALLS_REPORT = /^stats\/installs\/installs_(.+)_\d{6}_[a-z_]+\.csv$/;

// ----------------------------------------------------------------- les rapports

export interface InstallsDay {
    day: number;
    downloads: number | null;
    updates: number | null;
    uninstalls: number | null;
    activeDevices: number | null;
}

const atLeastZero = (value: number | null): number | null => (value === null ? null : Math.max(0, value));

/** Le CSV mensuel des installations (UTF-16), lu par les noms de ses colonnes. */
export function parseInstalls(bytes: Uint8Array): InstallsDay[] {
    const { header, rows } = parseCsv(decodeText(bytes));
    const at = {
        date: columnIndex(header, ['Date']),
        downloads: columnIndex(header, ['Daily User Installs']),
        uninstalls: columnIndex(header, ['Daily User Uninstalls']),
        updates: columnIndex(header, ['Update events', 'Daily Device Upgrades']),
        active: columnIndex(header, ['Active Device Installs'])
    };
    if (at.date < 0 || at.downloads < 0) {
        throw new StoreError('google', 200, {
            message: 'Le rapport des installations de Google Play a changé de forme : il ne se lit plus.'
        });
    }
    const out: InstallsDay[] = [];
    for (const row of rows) {
        const day = parseDay(cell(row, at.date));
        if (day === null) continue;
        out.push({
            day,
            downloads: atLeastZero(parseCount(cell(row, at.downloads))),
            updates: atLeastZero(parseCount(cell(row, at.updates))),
            uninstalls: atLeastZero(parseCount(cell(row, at.uninstalls))),
            activeDevices: atLeastZero(parseCount(cell(row, at.active)))
        });
    }
    return out;
}

/** Le CSV mensuel des notes : la moyenne de toutes les notes, jour par jour. « NA » n'en est pas une. */
export function parseRatings(bytes: Uint8Array): { day: number; rating: number }[] {
    const { header, rows } = parseCsv(decodeText(bytes));
    const at = { date: columnIndex(header, ['Date']), rating: columnIndex(header, ['Total Average Rating']) };
    if (at.date < 0 || at.rating < 0) {
        throw new StoreError('google', 200, {
            message: 'Le rapport des notes de Google Play a changé de forme : il ne se lit plus.'
        });
    }
    const out: { day: number; rating: number }[] = [];
    for (const row of rows) {
        const day = parseDay(cell(row, at.date));
        const rating = parseDecimal(cell(row, at.rating));
        if (day !== null && rating !== null && rating > 0 && rating <= 5) out.push({ day, rating });
    }
    return out;
}

/** Les ventes d'un paquet : par jour, puis par devise. */
export type PackageSales = Map<number, Map<string, { amount: number; units: number }>>;

/**
 * Le CSV du rapport de ventes estimées d'un mois : par paquet, par jour et par
 * devise de vente. Ce sont des montants bruts, avant la commission de Google et
 * hors taxes ; un remboursement compte en négatif.
 */
export function parseSales(csv: string): Map<string, PackageSales> {
    const { header, rows } = parseCsv(csv);
    const at = {
        date: columnIndex(header, ['Order Charged Date', 'Transaction Date']),
        product: columnIndex(header, ['Product ID', 'Package ID']),
        status: columnIndex(header, ['Financial Status', 'Transaction Type']),
        amount: columnIndex(header, ['Item Price', 'Charged Amount']),
        currency: columnIndex(header, ['Currency of Sale', 'Buyer Currency'])
    };
    if (at.date < 0 || at.product < 0 || at.amount < 0 || at.currency < 0) {
        throw new StoreError('google', 200, {
            message: 'Le rapport des ventes de Google Play a changé de forme : il ne se lit plus.'
        });
    }
    const out = new Map<string, PackageSales>();
    for (const row of rows) {
        const pkg = cell(row, at.product);
        const day = parseDay(cell(row, at.date));
        const amount = parseDecimal(cell(row, at.amount));
        const currency = cell(row, at.currency).toUpperCase();
        const status = cell(row, at.status);
        if (!pkg || day === null || amount === null || amount === 0 || !/^[A-Z]{3}$/.test(currency)) continue;
        if (/declin|cancel/i.test(status)) continue;
        const refund = /refund|charge ?back|reversal/i.test(status);
        const days = out.get(pkg) ?? new Map<number, Map<string, { amount: number; units: number }>>();
        const currencies = days.get(day) ?? new Map<string, { amount: number; units: number }>();
        const entry = currencies.get(currency) ?? { amount: 0, units: 0 };
        entry.amount += refund ? -Math.abs(amount) : amount;
        entry.units += refund ? -1 : 1;
        currencies.set(currency, entry);
        days.set(day, currencies);
        out.set(pkg, days);
    }
    for (const days of out.values()) {
        for (const currencies of days.values()) {
            for (const entry of currencies.values()) entry.amount = Math.round(entry.amount * 1000) / 1000;
        }
    }
    return out;
}

// ----------------------------------------------------------------- les apps

/** Les apps du compte par la Reporting API. */
async function searchApps(creds: GoogleCredentials, signal?: AbortSignal, limit?: number): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < APPS_PAGES; page++) {
        const query = new URLSearchParams({ pageSize: String(limit ?? 1000) });
        if (pageToken) query.set('pageToken', pageToken);
        const doc = await readStoreJson<{
            apps?: { packageName?: unknown; displayName?: unknown }[];
            nextPageToken?: unknown;
        }>('google', await googleApi(creds, `${REPORTING}/apps:search?${query.toString()}`, { signal }));
        for (const app of doc.apps ?? []) {
            const pkg = text(app.packageName);
            if (pkg === null || !GOOGLE_PACKAGE.test(pkg)) continue;
            out.push({ externalId: pkg, name: text(app.displayName) ?? pkg, bundleId: null });
        }
        pageToken = text(doc.nextPageToken);
        if (pageToken === null || limit !== undefined) break;
    }
    return out;
}

/**
 * Les apps que voit le compte de service. Sans la Reporting API, les noms de
 * paquets se lisent aux noms des rapports d'installations du bucket.
 */
export async function listGoogleApps(creds: GoogleCredentials, signal?: AbortSignal): Promise<StoreApp[]> {
    try {
        return await searchApps(creds, signal);
    } catch (e) {
        if (!(e instanceof StoreError) || e.status !== 403) throw e;
    }
    const packages = new Set<string>();
    for (const object of await listObjects(creds, 'stats/installs/installs_', signal)) {
        const pkg = INSTALLS_NAME.exec(object.name)?.[1];
        if (pkg && GOOGLE_PACKAGE.test(pkg)) packages.add(pkg);
    }
    return [...packages].sort().map((pkg) => ({ externalId: pkg, name: pkg, bundleId: null }));
}

// ----------------------------------------------------------------- les avis

interface GoogleComment {
    text?: unknown;
    lastModified?: unknown;
    starRating?: unknown;
    appVersionName?: unknown;
}

interface GoogleReview {
    reviewId?: unknown;
    authorName?: unknown;
    comments?: { userComment?: GoogleComment; developerComment?: GoogleComment }[];
}

/** Un avis Google porte son titre et son texte dans un même champ, séparés par une tabulation. */
function toReview(raw: GoogleReview): StoreReview | null {
    const id = text(raw.reviewId);
    const user = raw.comments?.find((c) => c.userComment)?.userComment;
    const developer = raw.comments?.find((c) => c.developerComment)?.developerComment;
    const rating = Number(user?.starRating);
    const createdAt = secondsOf(user?.lastModified);
    if (id === null || !REVIEW_ID.test(id) || !user || createdAt === null) return null;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    const full = typeof user.text === 'string' ? user.text.trim() : '';
    const tab = full.indexOf('\t');
    const reply = text(developer?.text);
    return {
        externalId: id,
        rating,
        title: tab >= 0 ? full.slice(0, tab).trim() : '',
        body: tab >= 0 ? full.slice(tab + 1).trim() : full,
        author: text(raw.authorName) ?? '',
        territory: null,
        appVersion: text(user.appVersionName),
        createdAt,
        reply:
            reply === null
                ? null
                : { body: reply, at: secondsOf(developer?.lastModified), state: 'published', responseId: null }
    };
}

/** Les avis d'un paquet : Google ne rend que ceux des sept derniers jours. */
export async function fetchGoogleReviews(
    creds: GoogleCredentials,
    pkg: string,
    signal?: AbortSignal,
    limit?: number
): Promise<StoreReview[]> {
    const out: StoreReview[] = [];
    let token: string | null = null;
    for (let page = 0; page < REVIEW_PAGES; page++) {
        const query = new URLSearchParams({ maxResults: String(limit ?? 100) });
        if (token) query.set('token', token);
        const doc = await readStoreJson<{ reviews?: GoogleReview[]; tokenPagination?: { nextPageToken?: unknown } }>(
            'google',
            await googleApi(creds, `${PUBLISHER}/${assertPackage(pkg)}/reviews?${query.toString()}`, { signal })
        );
        for (const raw of doc.reviews ?? []) {
            const review = toReview(raw);
            if (review) out.push(review);
        }
        token = text(doc.tokenPagination?.nextPageToken);
        if (token === null || limit !== undefined) break;
    }
    return out;
}

interface RawRelease {
    releaseName?: unknown;
    releaseLifecycleState?: unknown;
    activeArtifacts?: { versionCode?: unknown }[];
}

/** Une version de la piste de production : Google ne lui donne ni date ni numéro à part de son nom. */
export interface GoogleVersion {
    version: string;
    /** La valeur brute de `releaseLifecycleState`. */
    state: string;
    /** Le plus haut `versionCode` livré, qui ordonne les versions. */
    code: number | null;
}

/**
 * Les versions de la piste de production, la plus récente d'abord. Une lecture
 * seule, sans ouvrir de modification, que la permission de lecture de la
 * qualité de l'app suffit à ouvrir.
 */
export async function fetchGoogleReleases(
    creds: GoogleCredentials,
    pkg: string,
    signal?: AbortSignal
): Promise<GoogleVersion[]> {
    const doc = await readStoreJson<{ releases?: RawRelease[] }>(
        'google',
        await googleApi(creds, `${PUBLISHER}/${assertPackage(pkg)}/tracks/production/releases`, { signal })
    );
    const out: GoogleVersion[] = [];
    for (const raw of doc.releases ?? []) {
        const codes = (raw.activeArtifacts ?? []).map((a) => Number(a.versionCode)).filter(Number.isFinite);
        const code = codes.length > 0 ? Math.max(...codes) : null;
        const version = text(raw.releaseName) ?? (code === null ? null : String(code));
        const state = text(raw.releaseLifecycleState);
        if (version !== null && state !== null) out.push({ version, state, code });
    }
    return out.sort((a, b) => (b.code ?? 0) - (a.code ?? 0));
}

/** Publie une réponse, ou remplace celle en place : Google la montre aussitôt. */
export async function replyGoogle(
    creds: GoogleCredentials,
    pkg: string,
    reviewId: string,
    body: string,
    signal?: AbortSignal
): Promise<StoreReply> {
    if (!REVIEW_ID.test(reviewId)) throw new Error('Identifiant d’avis Google invalide');
    const url = `${PUBLISHER}/${assertPackage(pkg)}/reviews/${encodeURIComponent(reviewId)}:reply`;
    const doc = await readStoreJson<{ result?: { replyText?: unknown; lastEdited?: unknown } }>(
        'google',
        await googleApi(creds, url, { method: 'POST', body: { replyText: body }, signal })
    );
    return {
        body: text(doc.result?.replyText) ?? body,
        at: secondsOf(doc.result?.lastEdited) ?? Math.floor(Date.now() / 1000),
        state: 'published',
        responseId: null
    };
}

// ----------------------------------------------------------------- la stabilité

export interface VitalsDay {
    day: number;
    crashRate: number | null;
    anrRate: number | null;
    users: number | null;
}

interface GoogleDate {
    year?: unknown;
    month?: unknown;
    day?: unknown;
}

function dayOfGoogleDate(value: GoogleDate | undefined): number | null {
    if (!value) return null;
    return dayOfDate(Number(value.year), Number(value.month), Number(value.day));
}

function civilDate(day: number): Record<string, unknown> {
    return { ...civilOf(day), timeZone: { id: VITALS_ZONE } };
}

function decimalOf(metrics: { metric?: unknown; decimalValue?: { value?: unknown } }[], name: string): number | null {
    const raw = metrics.find((m) => m.metric === name)?.decimalValue?.value;
    const value = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Le taux perçu d'un ensemble de métriques, jour par jour, avec ses
 * utilisateurs distincts. La fenêtre finit à la fraîcheur que Google annonce :
 * au-delà, la requête est refusée.
 */
async function metricSet(
    creds: GoogleCredentials,
    pkg: string,
    set: 'crashRateMetricSet' | 'anrRateMetricSet',
    metric: string,
    days: number,
    signal?: AbortSignal
): Promise<Map<number, { rate: number | null; users: number | null }>> {
    const base = `${REPORTING}/apps/${encodeURIComponent(assertPackage(pkg))}/${set}`;
    const meta = await readStoreJson<{
        freshnessInfo?: { freshnesses?: { aggregationPeriod?: unknown; latestEndTime?: GoogleDate }[] };
    }>('google', await googleApi(creds, base, { signal }));
    const end = dayOfGoogleDate(
        meta.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime
    );
    const out = new Map<number, { rate: number | null; users: number | null }>();
    if (end === null) return out;
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page++) {
        const doc = await readStoreJson<{
            rows?: { startTime?: GoogleDate; metrics?: { metric?: unknown; decimalValue?: { value?: unknown } }[] }[];
            nextPageToken?: unknown;
        }>(
            'google',
            await googleApi(creds, `${base}:query`, {
                method: 'POST',
                signal,
                body: {
                    timelineSpec: {
                        aggregationPeriod: 'DAILY',
                        startTime: civilDate(end - days),
                        endTime: civilDate(end)
                    },
                    metrics: [metric, 'distinctUsers'],
                    pageSize: 100,
                    ...(pageToken ? { pageToken } : {})
                }
            })
        );
        for (const row of doc.rows ?? []) {
            const day = dayOfGoogleDate(row.startTime);
            if (day === null) continue;
            const metrics = row.metrics ?? [];
            out.set(day, { rate: decimalOf(metrics, metric), users: decimalOf(metrics, 'distinctUsers') });
        }
        pageToken = text(doc.nextPageToken);
        if (pageToken === null) break;
    }
    return out;
}

/** Les taux perçus de plantage et d'ANR des derniers jours, et leurs utilisateurs. */
export async function fetchVitals(
    creds: GoogleCredentials,
    pkg: string,
    days: number,
    signal?: AbortSignal
): Promise<VitalsDay[]> {
    const crash = await metricSet(creds, pkg, 'crashRateMetricSet', 'userPerceivedCrashRate', days, signal);
    const anr = await metricSet(creds, pkg, 'anrRateMetricSet', 'userPerceivedAnrRate', days, signal);
    const out: VitalsDay[] = [];
    for (const day of new Set([...crash.keys(), ...anr.keys()])) {
        const c = crash.get(day);
        const a = anr.get(day);
        const users = c?.users ?? a?.users ?? null;
        out.push({
            day,
            crashRate: c?.rate ?? null,
            anrRate: a?.rate ?? null,
            users: users === null ? null : Math.round(users)
        });
    }
    return out.sort((x, y) => x.day - y.day);
}

// ----------------------------------------------------------------- le test d'un compte

/**
 * Ce que le compte de service sait lire. Un jeton refusé lève (la clé ne vaut
 * rien) ; un 403 ou un 404 laisse seulement la capacité de côté.
 */
export async function probeGoogle(creds: GoogleCredentials, signal?: AbortSignal): Promise<AppStoresCapability[]> {
    await googleToken(creds, signal);
    const capabilities = new Set<AppStoresCapability>();
    const tolerate = (e: unknown): void => {
        if (!(e instanceof StoreError) || !(e.refused || e.status === 404 || e.status === 400)) throw e;
    };

    let pkg: string | null = null;
    try {
        pkg = (await searchApps(creds, signal, 1))[0]?.externalId ?? null;
        capabilities.add('apps');
    } catch (e) {
        tolerate(e);
    }
    const reports: [AppStoresCapability, string][] = [
        ['downloads', 'stats/installs/installs_'],
        ['ratings', 'stats/ratings/ratings_']
    ];
    for (const [capability, prefix] of reports) {
        try {
            const [first] = await listObjects(creds, prefix, signal, 1);
            capabilities.add(capability);
            if (capability === 'downloads' && first) {
                capabilities.add('apps');
                pkg ??= INSTALLS_REPORT.exec(first.name)?.[1] ?? null;
            }
        } catch (e) {
            tolerate(e);
        }
    }
    // La liste du dossier des ventes peut passer quand ses fichiers restent fermés : on en ouvre un.
    try {
        const [first] = await listObjects(creds, 'sales/', signal, 1);
        if (first) await headObject(creds, first.name, signal);
        capabilities.add('revenue');
    } catch (e) {
        tolerate(e);
    }
    if (pkg !== null && GOOGLE_PACKAGE.test(pkg)) {
        try {
            await fetchGoogleReviews(creds, pkg, signal, 1);
            capabilities.add('reviews');
        } catch (e) {
            tolerate(e);
        }
        try {
            await fetchGoogleReleases(creds, pkg, signal);
            capabilities.add('versions');
        } catch (e) {
            tolerate(e);
        }
        try {
            const res = await googleApi(creds, `${REPORTING}/apps/${encodeURIComponent(pkg)}/crashRateMetricSet`, {
                signal
            });
            await res.body?.cancel().catch(() => undefined);
            capabilities.add('vitals');
        } catch (e) {
            tolerate(e);
        }
    }
    return [...capabilities];
}

/** Ce que le service appelle chez Google : remplacé par un double dans les tests. */
export const googleClient = {
    listApps: listGoogleApps,
    listObjects,
    downloadObject,
    fetchReviews: fetchGoogleReviews,
    fetchReleases: fetchGoogleReleases,
    fetchVitals
};

export type GoogleClient = typeof googleClient;
