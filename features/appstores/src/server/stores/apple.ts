import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

import {
    APPLE_APP_ID,
    APPLE_VENDOR_NUMBER,
    COUNTRY_CODE,
    type AppStoresCapability,
    type AppStoresReplyState
} from '../../contracts/domain';
import { FeatureError } from '@deveye/types/sdk/server';

import { isoDay, pacificToday } from '../days';
import { cell, columnIndex, parseCount, parseDecimal } from '../parse/csv';
import { parseTsv } from '../parse/tsv';
import { gunzip } from '../parse/unzip';
import {
    readBody,
    readStoreJson,
    storeCall,
    StoreError,
    type StoreApp,
    type StoreRating,
    type StoreReply,
    type StoreReview
} from './types';

/**
 * App Store Connect, avec la clé d'API d'équipe que l'utilisateur colle : un
 * jeton ES256 signé ici, l'API JSON pour les apps, les avis et les versions,
 * le rapport de ventes quotidien pour les téléchargements et les produits. La
 * note vient de l'API publique iTunes, sans clé.
 */

const API = 'https://api.appstoreconnect.apple.com';
const API_HOST = 'api.appstoreconnect.apple.com';
const LOOKUP = 'https://itunes.apple.com/lookup';

/** Apple refuse un jeton de plus de vingt minutes. */
const TOKEN_SECONDS = 19 * 60;
/** Un jeton se renouvelle une minute avant sa fin, pour ne jamais partir périmé. */
const TOKEN_MARGIN_MS = 60_000;
const CACHE_MAX = 500;

/** Un rapport quotidien compressé, et décompressé : larges, même pour un gros compte. */
const REPORT_MAX_BYTES = 32 * 1024 * 1024;
const REPORT_MAX_OUTPUT = 256 * 1024 * 1024;
const APPS_PAGES = 10;

/**
 * Les « Product Type Identifiers » d'un premier téléchargement d'app. À tenir
 * d'accord avec la page d'Apple qui les liste (« Product type identifiers »,
 * aide d'App Store Connect) : mises à jour, retéléchargements et achats
 * intégrés n'en sont pas.
 */
const FIRST_DOWNLOAD_TYPES = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);
/** Les mises à jour, de la même page. */
const UPDATE_TYPES = new Set(['7', '7F', '7T', 'F7']);

/** Une identité de review Apple : un UUID, ou ce qui y ressemble. */
const REVIEW_ID = /^[A-Za-z0-9-]{1,100}$/;

export interface AppleCredentials {
    issuerId: string;
    keyId: string;
    vendorNumber: string;
    /** Le `.p8`, en PEM. */
    privateKey: string;
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
export function forgetAppleTokens(): void {
    KEYS.clear();
    TOKENS.clear();
}

/**
 * Le `.p8` d'une clé d'API, tel que l'utilisateur le colle : une clé EC sur
 * P-256, rien d'autre. Lève `validation` avec une phrase qui dit quoi faire.
 */
export function parseAppleKey(raw: string): string {
    const pem = raw.replace(/\\n/g, '\n').trim();
    let key: KeyObject;
    try {
        key = createPrivateKey(pem);
    } catch {
        throw new FeatureError(
            'validation',
            'Ce texte n’est pas une clé .p8 d’App Store Connect : collez le contenu entier du fichier, lignes BEGIN et END comprises.'
        );
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new FeatureError(
            'validation',
            'Cette clé n’est pas une clé d’API App Store Connect : Apple les livre en .p8, sur la courbe P-256.'
        );
    }
    return pem;
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

/** Le jeton d'une clé, signé ES256 (signature brute r‖s, pas DER), gardé jusqu'à une minute de sa fin. */
export function appleToken(creds: AppleCredentials, nowMs: number = Date.now()): string {
    const ref = sha256(`${creds.issuerId}|${creds.keyId}|${creds.privateKey}`);
    const cached = TOKENS.get(ref);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > nowMs) return cached.token;
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + TOKEN_SECONDS;
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: creds.issuerId, iat, exp, aud: 'appstoreconnect-v1' })).toString(
        'base64url'
    );
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
        key: keyOf(creds.privateKey),
        dsaEncoding: 'ieee-p1363'
    }).toString('base64url');
    const token = `${head}.${body}.${signature}`;
    remember(TOKENS, ref, { token, expiresAt: exp * 1000 });
    return token;
}

function assertAppId(appId: string): string {
    if (!APPLE_APP_ID.test(appId)) throw new Error('Identifiant d’app Apple invalide');
    return appId;
}

function assertReviewId(id: string): string {
    if (!REVIEW_ID.test(id)) throw new Error('Identifiant d’avis Apple invalide');
    return id;
}

/** Un lien de page rendu par Apple : suivi seulement s'il reste chez Apple. */
function nextLink(url: string): string {
    const parsed = URL.parse(url);
    if (!parsed || parsed.protocol !== 'https:' || parsed.host !== API_HOST || !parsed.pathname.startsWith('/v1/')) {
        throw new StoreError('apple', 0, { message: 'Apple a rendu un lien de page inattendu.' });
    }
    return parsed.toString();
}

interface ApiInit {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    accept?: string;
    signal?: AbortSignal;
}

function appleApi(
    creds: AppleCredentials,
    target: string,
    init: ApiInit = {},
    expected: readonly number[] = []
): Promise<Response> {
    const url = target.startsWith('https://') ? nextLink(target) : `${API}${target}`;
    return storeCall(
        'apple',
        url,
        {
            method: init.method ?? 'GET',
            headers: {
                Authorization: `Bearer ${appleToken(creds)}`,
                Accept: init.accept ?? 'application/json',
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            signal: init.signal
        },
        expected
    );
}

interface Resource<A> {
    id: string;
    type: string;
    attributes?: A;
    relationships?: Record<string, { data?: { id: string; type: string } | null } | undefined>;
}

interface ListDocument<A, I = unknown> {
    data?: Resource<A>[];
    included?: Resource<I>[];
    links?: { next?: string };
}

interface OneDocument<A> {
    data?: Resource<A>;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Secondes epoch d'une date ISO d'Apple, `null` si elle ne se lit pas. */
function secondsOf(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

interface AppAttributes {
    name?: unknown;
    bundleId?: unknown;
    sku?: unknown;
}

export interface AppleApp extends StoreApp {
    sku: string | null;
}

function toApp(resource: Resource<AppAttributes>): AppleApp | null {
    if (!APPLE_APP_ID.test(resource.id)) return null;
    return {
        externalId: resource.id,
        name: text(resource.attributes?.name) ?? resource.id,
        bundleId: text(resource.attributes?.bundleId),
        sku: text(resource.attributes?.sku)
    };
}

const APP_FIELDS = new URLSearchParams({ 'fields[apps]': 'name,bundleId,sku' }).toString();

/** Les apps que la clé voit, pour le choix à l'ajout. */
export async function listAppleApps(creds: AppleCredentials, signal?: AbortSignal): Promise<AppleApp[]> {
    const out: AppleApp[] = [];
    let target: string | null = `/v1/apps?${APP_FIELDS}&limit=200`;
    for (let page = 0; target !== null && page < APPS_PAGES; page++) {
        const doc: ListDocument<AppAttributes> = await readStoreJson(
            'apple',
            await appleApi(creds, target, { signal })
        );
        for (const resource of doc.data ?? []) {
            const app = toApp(resource);
            if (app) out.push(app);
        }
        target = doc.links?.next ?? null;
    }
    return out;
}

/** Le nom, l'identifiant de paquet et le SKU d'une app ; `null` quand Apple ne la connaît pas. */
export async function fetchAppleApp(
    creds: AppleCredentials,
    appId: string,
    signal?: AbortSignal
): Promise<AppleApp | null> {
    const res = await appleApi(creds, `/v1/apps/${assertAppId(appId)}?${APP_FIELDS}`, { signal }, [404]);
    if (res.status === 404) return null;
    const doc = await readStoreJson<OneDocument<AppAttributes>>('apple', res);
    return doc.data ? toApp(doc.data) : null;
}

// ----------------------------------------------------------------- les ventes

/** Une ligne du rapport de ventes quotidien. */
export interface AppleSalesRow {
    appleId: string;
    parentId: string;
    sku: string;
    productType: string;
    units: number;
    /** Le produit net d'une unité, dans `currency`. */
    proceeds: number;
    currency: string;
    /** Le pays de l'App Store où l'unité s'est vendue, en capitales. */
    country: string;
}

/**
 * Le rapport d'un jour : ses lignes, rien (aucune vente), pas encore publié
 * (à retenter), ou hors de ce qu'Apple garde.
 */
export type AppleSalesReport =
    { kind: 'rows'; rows: AppleSalesRow[] } | { kind: 'empty' } | { kind: 'pending' } | { kind: 'expired' };

/** Un rapport qu'Apple a changé de forme ne se lit plus : mieux vaut le dire que compter faux. */
export function parseSalesReport(tsv: string): AppleSalesRow[] {
    const { header, rows } = parseTsv(tsv);
    const at = {
        appleId: columnIndex(header, ['Apple Identifier']),
        parentId: columnIndex(header, ['Parent Identifier']),
        sku: columnIndex(header, ['SKU']),
        productType: columnIndex(header, ['Product Type Identifier']),
        units: columnIndex(header, ['Units']),
        proceeds: columnIndex(header, ['Developer Proceeds']),
        currency: columnIndex(header, ['Currency of Proceeds']),
        country: columnIndex(header, ['Country Code'])
    };
    if (at.appleId < 0 || at.productType < 0 || at.units < 0) {
        throw new StoreError('apple', 200, {
            message: 'Le rapport de ventes d’Apple a changé de forme : il ne se lit plus.'
        });
    }
    return rows.map((row) => ({
        appleId: cell(row, at.appleId),
        parentId: cell(row, at.parentId),
        sku: cell(row, at.sku),
        productType: cell(row, at.productType).toUpperCase(),
        units: parseCount(cell(row, at.units)) ?? 0,
        proceeds: parseDecimal(cell(row, at.proceeds)) ?? 0,
        currency: cell(row, at.currency).toUpperCase(),
        country: cell(row, at.country).toUpperCase()
    }));
}

/** Ce qu'un jour de ventes dit d'une app. Les montants sont des produits nets, par devise. */
export interface AppleDayFigures {
    downloads: number;
    updates: number;
    /** Les premiers téléchargements par pays ; un pays sans téléchargement n'y est pas. */
    countries: Map<string, number>;
    revenue: Map<string, { amount: number; units: number }>;
}

/**
 * Les chiffres d'une app dans le rapport de son compte : ses propres lignes,
 * et les achats intégrés que leur « Parent Identifier » rattache à son SKU.
 */
export function figuresFor(
    rows: readonly AppleSalesRow[],
    app: { appleId: string; sku: string | null }
): AppleDayFigures {
    let downloads = 0;
    let updates = 0;
    const countries = new Map<string, number>();
    const revenue = new Map<string, { amount: number; units: number }>();
    for (const row of rows) {
        const own = row.appleId === app.appleId;
        if (!own && (!app.sku || row.parentId !== app.sku)) continue;
        if (own && FIRST_DOWNLOAD_TYPES.has(row.productType)) {
            downloads += row.units;
            if (COUNTRY_CODE.test(row.country)) {
                countries.set(row.country, (countries.get(row.country) ?? 0) + row.units);
            }
        }
        if (own && UPDATE_TYPES.has(row.productType)) updates += row.units;
        if (row.proceeds !== 0 && /^[A-Z]{3}$/.test(row.currency)) {
            const entry = revenue.get(row.currency) ?? { amount: 0, units: 0 };
            entry.amount += row.units * row.proceeds;
            entry.units += row.units;
            revenue.set(row.currency, entry);
        }
    }
    for (const entry of revenue.values()) entry.amount = Math.round(entry.amount * 1000) / 1000;
    // Un remboursement compte en négatif : un pays qui n'a rien gardé n'a rien téléchargé.
    for (const [country, units] of countries) if (units <= 0) countries.delete(country);
    return { downloads: Math.max(0, downloads), updates: Math.max(0, updates), countries, revenue };
}

/** Le SKU d'une app, lu sur ses propres lignes : de quoi rattacher ses achats intégrés. */
export function skuOf(rows: readonly AppleSalesRow[], appleId: string): string | null {
    return rows.find((row) => row.appleId === appleId && row.sku !== '')?.sku ?? null;
}

/**
 * Un rapport absent. Apple répond 404 pour un jour sans vente comme pour un
 * jour pas encore publié : seul l'âge du jour tranche, à l'heure du Pacifique.
 */
function missingReport(day: number, status: number, nowMs: number): AppleSalesReport {
    const today = pacificToday(nowMs);
    if (status === 410 || (status === 400 && day < today - 300)) return { kind: 'expired' };
    if (status === 404) return day <= today - 2 ? { kind: 'empty' } : { kind: 'pending' };
    throw new StoreError('apple', status);
}

/** Le rapport DAILY SALES SUMMARY d'un jour, pour tout le compte du numéro de fournisseur. */
export async function fetchSalesReport(
    creds: AppleCredentials,
    day: number,
    signal?: AbortSignal,
    nowMs: number = Date.now()
): Promise<AppleSalesReport> {
    if (!APPLE_VENDOR_NUMBER.test(creds.vendorNumber)) throw new Error('Numéro de fournisseur Apple invalide');
    const query = new URLSearchParams({
        'filter[frequency]': 'DAILY',
        'filter[reportType]': 'SALES',
        'filter[reportSubType]': 'SUMMARY',
        'filter[vendorNumber]': creds.vendorNumber,
        'filter[reportDate]': isoDay(day),
        // Le 1_1 rend 404 sur ce rapport.
        'filter[version]': '1_0'
    });
    const res = await appleApi(
        creds,
        `/v1/salesReports?${query.toString()}`,
        { accept: 'application/a-gzip', signal },
        [400, 404, 410]
    );
    if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return missingReport(day, res.status, nowMs);
    }
    const body = await readBody('apple', res, REPORT_MAX_BYTES);
    let tsv: string;
    try {
        tsv = (await gunzip(body, REPORT_MAX_OUTPUT)).toString('utf8');
    } catch (e) {
        throw new StoreError('apple', 200, { message: 'Le rapport de ventes d’Apple ne s’ouvre pas.', cause: e });
    }
    return { kind: 'rows', rows: parseSalesReport(tsv) };
}

// ----------------------------------------------------------------- les avis

interface ReviewAttributes {
    rating?: unknown;
    title?: unknown;
    body?: unknown;
    reviewerNickname?: unknown;
    createdDate?: unknown;
    territory?: unknown;
}

interface ResponseAttributes {
    responseBody?: unknown;
    lastModifiedDate?: unknown;
    state?: unknown;
}

function replyState(value: unknown): AppStoresReplyState {
    return value === 'PUBLISHED' ? 'published' : 'pending';
}

function toReply(resource: Resource<ResponseAttributes> | undefined): StoreReply | null {
    const body = text(resource?.attributes?.responseBody);
    if (!resource || body === null) return null;
    return {
        body,
        at: secondsOf(resource.attributes?.lastModifiedDate),
        state: replyState(resource.attributes?.state),
        responseId: resource.id
    };
}

export interface AppleReviewPage {
    reviews: StoreReview[];
    /** La page suivante, plus ancienne ; `null` à la fin. */
    next: string | null;
}

/** La première page des avis d'une app, du plus récent au plus ancien, réponses comprises. */
export function firstReviewsPage(appId: string): string {
    const query = new URLSearchParams({ sort: '-createdDate', limit: '200', include: 'response' });
    return `/v1/apps/${assertAppId(appId)}/customerReviews?${query.toString()}`;
}

export async function fetchReviewsPage(
    creds: AppleCredentials,
    target: string,
    signal?: AbortSignal
): Promise<AppleReviewPage> {
    const doc = await readStoreJson<ListDocument<ReviewAttributes, ResponseAttributes>>(
        'apple',
        await appleApi(creds, target, { signal })
    );
    const responses = new Map((doc.included ?? []).map((r) => [r.id, r]));
    const reviews: StoreReview[] = [];
    for (const resource of doc.data ?? []) {
        const rating = Number(resource.attributes?.rating);
        const createdAt = secondsOf(resource.attributes?.createdDate);
        if (!REVIEW_ID.test(resource.id) || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
        if (createdAt === null) continue;
        const responseId = resource.relationships?.response?.data?.id;
        reviews.push({
            externalId: resource.id,
            rating,
            title: text(resource.attributes?.title) ?? '',
            body: text(resource.attributes?.body) ?? '',
            author: text(resource.attributes?.reviewerNickname) ?? '',
            territory: text(resource.attributes?.territory),
            appVersion: null,
            createdAt,
            reply: responseId ? toReply(responses.get(responseId)) : null
        });
    }
    return { reviews, next: doc.links?.next ? nextLink(doc.links.next) : null };
}

/** Une réponse publiée ou en attente, par son identifiant ; `null` quand elle n'existe plus. */
export async function fetchResponse(
    creds: AppleCredentials,
    responseId: string,
    signal?: AbortSignal
): Promise<StoreReply | null> {
    const res = await appleApi(
        creds,
        `/v1/customerReviewResponses/${encodeURIComponent(assertReviewId(responseId))}`,
        { signal },
        [404]
    );
    if (res.status === 404) return null;
    return toReply((await readStoreJson<OneDocument<ResponseAttributes>>('apple', res)).data);
}

async function responseOfReview(
    creds: AppleCredentials,
    reviewId: string,
    signal?: AbortSignal
): Promise<StoreReply | null> {
    const res = await appleApi(
        creds,
        `/v1/customerReviews/${encodeURIComponent(assertReviewId(reviewId))}/response`,
        { signal },
        [404]
    );
    if (res.status === 404) return null;
    return toReply((await readStoreJson<OneDocument<ResponseAttributes>>('apple', res)).data);
}

async function deleteResponse(creds: AppleCredentials, responseId: string, signal?: AbortSignal): Promise<void> {
    const res = await appleApi(
        creds,
        `/v1/customerReviewResponses/${encodeURIComponent(assertReviewId(responseId))}`,
        { method: 'DELETE', signal },
        [404]
    );
    await res.body?.cancel().catch(() => undefined);
}

async function createResponse(
    creds: AppleCredentials,
    reviewId: string,
    body: string,
    signal?: AbortSignal
): Promise<StoreReply> {
    const res = await appleApi(creds, '/v1/customerReviewResponses', {
        method: 'POST',
        signal,
        body: {
            data: {
                type: 'customerReviewResponses',
                attributes: { responseBody: body },
                relationships: { review: { data: { type: 'customerReviews', id: reviewId } } }
            }
        }
    });
    const created = toReply((await readStoreJson<OneDocument<ResponseAttributes>>('apple', res)).data);
    return created ?? { body, at: Math.floor(Date.now() / 1000), state: 'pending', responseId: null };
}

/**
 * Publie une réponse. Apple ne modifie pas une réponse : on supprime celle en
 * place, puis on en crée une, qui attend sa relecture (`pending`).
 */
export async function replyApple(
    creds: AppleCredentials,
    reviewId: string,
    body: string,
    previousResponseId: string | null,
    signal?: AbortSignal
): Promise<StoreReply> {
    assertReviewId(reviewId);
    if (previousResponseId) await deleteResponse(creds, previousResponseId, signal);
    try {
        return await createResponse(creds, reviewId, body, signal);
    } catch (e) {
        // Une réponse que la synchronisation n'avait pas encore vue.
        if (!(e instanceof StoreError) || e.status !== 409) throw e;
        const existing = await responseOfReview(creds, reviewId, signal);
        if (!existing?.responseId) throw e;
        await deleteResponse(creds, existing.responseId, signal);
        return createResponse(creds, reviewId, body, signal);
    }
}

// ----------------------------------------------------------------- versions et note

export interface AppleVersion {
    id: string;
    version: string;
    /** La valeur brute d'`appVersionState`. */
    state: string;
    createdAt: number | null;
}

interface VersionAttributes {
    versionString?: unknown;
    appVersionState?: unknown;
    createdDate?: unknown;
}

/** Les dernières versions d'une app, la plus récente d'abord. */
export async function fetchVersions(
    creds: AppleCredentials,
    appId: string,
    signal?: AbortSignal
): Promise<AppleVersion[]> {
    const query = new URLSearchParams({
        'fields[appStoreVersions]': 'versionString,appVersionState,platform,createdDate',
        limit: '10'
    });
    const doc = await readStoreJson<ListDocument<VersionAttributes>>(
        'apple',
        await appleApi(creds, `/v1/apps/${assertAppId(appId)}/appStoreVersions?${query.toString()}`, { signal })
    );
    const out: AppleVersion[] = [];
    for (const resource of doc.data ?? []) {
        const version = text(resource.attributes?.versionString);
        const state = text(resource.attributes?.appVersionState);
        if (version === null || state === null) continue;
        out.push({ id: resource.id, version, state, createdAt: secondsOf(resource.attributes?.createdDate) });
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** La note d'une app dans un pays, par l'API publique iTunes ; `null` sans note. */
export async function fetchAppleRating(
    appId: string,
    country: string,
    signal?: AbortSignal
): Promise<StoreRating | null> {
    if (!COUNTRY_CODE.test(country)) throw new Error('Code pays invalide');
    const query = new URLSearchParams({ id: assertAppId(appId), country: country.toLowerCase() });
    const res = await storeCall('apple', `${LOOKUP}?${query.toString()}`, {
        headers: { Accept: 'application/json' },
        signal
    });
    const doc = await readStoreJson<{ results?: { averageUserRating?: unknown; userRatingCount?: unknown }[] }>(
        'apple',
        res
    );
    const first = doc.results?.[0];
    const rating = Number(first?.averageUserRating);
    if (!first || first.averageUserRating === undefined || !Number.isFinite(rating)) return null;
    const count = Number(first.userRatingCount);
    return {
        rating: Math.min(5, Math.max(0, rating)),
        count: Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null
    };
}

// ----------------------------------------------------------------- le test d'une clé

/**
 * Ce que la clé sait lire, sondé un point d'accès après l'autre. Un 401 dit la
 * clé refusée et lève ; un 403 laisse seulement la capacité de côté. La note
 * ne demande aucune clé.
 */
export async function probeApple(
    creds: AppleCredentials,
    signal?: AbortSignal,
    nowMs: number = Date.now()
): Promise<AppStoresCapability[]> {
    const capabilities = new Set<AppStoresCapability>(['ratings']);
    const tolerate = (e: unknown): void => {
        if (!(e instanceof StoreError) || e.status === 401 || !(e.refused || e.status === 400 || e.status === 404)) {
            throw e;
        }
    };

    let appId: string | null = null;
    try {
        const doc = await readStoreJson<ListDocument<AppAttributes>>(
            'apple',
            await appleApi(creds, '/v1/apps?fields[apps]=name&limit=1', { signal })
        );
        capabilities.add('apps');
        appId = doc.data?.[0]?.id ?? null;
    } catch (e) {
        tolerate(e);
    }

    // Un rapport rendu, même illisible ici, dit que la clé ouvre les ventes.
    let sales = false;
    try {
        await fetchSalesReport(creds, pacificToday(nowMs) - 3, signal, nowMs);
        sales = true;
    } catch (e) {
        if (e instanceof StoreError && e.status === 200) sales = true;
        else tolerate(e);
    }
    if (sales) {
        capabilities.add('downloads');
        capabilities.add('revenue');
    }

    if (appId !== null && APPLE_APP_ID.test(appId)) {
        const probes: [AppStoresCapability, string][] = [
            ['reviews', `/v1/apps/${appId}/customerReviews?limit=1`],
            ['versions', `/v1/apps/${appId}/appStoreVersions?limit=1`]
        ];
        for (const [capability, target] of probes) {
            try {
                const res = await appleApi(creds, target, { signal });
                await res.body?.cancel().catch(() => undefined);
                capabilities.add(capability);
            } catch (e) {
                tolerate(e);
            }
        }
    }
    return [...capabilities];
}

/** Ce que le service appelle chez Apple : remplacé par un double dans les tests. */
export const appleClient = {
    fetchApp: fetchAppleApp,
    fetchSalesReport,
    fetchReviewsPage,
    fetchResponse,
    fetchVersions,
    fetchRating: fetchAppleRating
};

export type AppleClient = typeof appleClient;
