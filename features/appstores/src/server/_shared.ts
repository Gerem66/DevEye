import { createHash } from 'node:crypto';

import {
    APP_STORES,
    appStoresAppSchema,
    APPSTORES_CAPABILITIES,
    type AppStore,
    type AppStoresApp,
    type AppStoresCapability,
    type AppStoresListing,
    type AppStoresSource,
    type AppStoresSyncFailure,
    type AppStoresVersion
} from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { DAY_SECONDS } from './days';
import type { AppRow, AppStoresRepo, ListingRow, SourceRow } from './repo';
import type { AppStoresSync } from './service';
import type { StoreReply } from './stores/types';

/**
 * Le socle des handlers. Un seul chiffre, l'étage ouvert (`ctx.cipher()`) :
 * la synchronisation relit tout sans session, clés comprises.
 */

export type Ctx = SdkFeatureContext<AppStoresRepo>;

/** Une source refusée trois fois de suite est dite perdue : l'écran le montre, l'avis part. */
export const LOST_AFTER_REFUSALS = 3;

/** Ce que porte `ft_appstores_apps.content`. */
export interface StoredApp {
    name: string;
    ratingCountry: string;
}

/** Ce que porte `ft_appstores_listings.content` : l'identité de l'app chez son store. */
export interface StoredListing {
    externalId: string;
    storeName: string | null;
    bundleId: string | null;
    /** Apple : ce qui rattache les achats intégrés du rapport de ventes à l'app. */
    sku: string | null;
}

/** Ce que le service seul écrit dans `ft_appstores_listings.state`. */
export interface ListingState {
    versions?: AppStoresVersion[];
    /** La phase vue de chaque version Apple, par identifiant : ce qui décide d'un avis. */
    phases?: Record<string, string>;
    rating?: number | null;
    ratingCount?: number | null;
    /** Le premier jour que le rattrapage va chercher, fixé au premier passage. */
    backfillFrom?: number;
    backfillDone?: boolean;
    /** Apple : le prochain jour que le rattrapage lit, en descendant ; absent, il reprend sous `history_from`. */
    backfillAt?: number;
    /** Le premier passage des avis est fait : ce qui arrive ensuite est neuf. */
    reviewsSeeded?: boolean;
    /** Où reprend la lecture des avis Apple, quand une passe n'a pas tout lu. */
    reviewsCursor?: string | null;
    /** Les `etag` des rapports de Google Play déjà lus, par nom d'objet. */
    etags?: Record<string, string>;
    /** Au-dessus du seuil de Google ou non, sur 28 jours ; absent avant la première mesure. */
    vitals?: { crash?: boolean; anr?: boolean; day?: number };
    /** La nature de `sync_error`, écrite avec elle. */
    failure?: AppStoresSyncFailure;
    /** L'icône que montre le store, `null` s'il n'en montre pas ; absente, elle n'a pas encore été cherchée. */
    icon?: string | null;
    /** Google : la dernière lecture de l'icône, sur la page publique de l'app. */
    iconAt?: number;
}

/** Ce que porte `ft_appstores_sources.content` : rien de secret. */
export interface StoredSource {
    label: string;
    issuerId?: string;
    keyId?: string;
    vendorNumber?: string;
    clientEmail?: string;
    bucket?: string;
    privateKeyId?: string | null;
}

/** Ce que porte `ft_appstores_reviews.content`. */
export interface StoredReview {
    externalId: string;
    title: string;
    body: string;
    author: string;
    territory: string | null;
    appVersion: string | null;
    reply: StoreReply | null;
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: SdkCipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

export async function sealJson(cipher: SdkCipher, value: unknown): Promise<string> {
    return cipher.encrypt(JSON.stringify(value));
}

/**
 * L'identité d'une app au store dans un espace. Le chiffrement étant non
 * déterministe, `content` ne peut porter l'unicité : ce condensé la porte.
 */
export function externalRef(store: AppStore, externalId: string): string {
    return createHash('sha256').update(`${store}:${externalId}`).digest('hex').slice(0, 32);
}

/** L'identité d'un avis, par le même condensé. */
export const reviewRef = externalRef;

export function capabilitiesOf(column: string): AppStoresCapability[] {
    const known = new Set<string>(APPSTORES_CAPABILITIES);
    return column.split(',').filter((value): value is AppStoresCapability => known.has(value));
}

export function capabilitiesColumn(capabilities: readonly AppStoresCapability[]): string {
    return APPSTORES_CAPABILITIES.filter((c) => capabilities.includes(c)).join(',');
}

/** Un instant en secondes epoch. */
export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

// ----------------------------------------------------------------- le service

let syncRef: AppStoresSync | null = null;

export function setSync(sync: AppStoresSync | null): void {
    syncRef = sync;
}

/** Le service de fond, ou `null` hors service (tests, maintenance) : chaque appelant dégrade. */
export function syncOf(): AppStoresSync | null {
    return syncRef;
}

// ----------------------------------------------------------------- les apps

/**
 * Charge une app visible d'ici, ou lève `not_found` : la frontière d'espace de
 * la feature, par laquelle commence toute commande qui prend un `appId`.
 */
export async function loadApp(ctx: Ctx, appId: number, level: 'read' | 'write' = 'read'): Promise<AppRow> {
    const row = await ctx.repo.findVisibleApp(appId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'App introuvable');
    await ctx.items.assert(String(appId), level);
    return row;
}

/** Comme {@link loadApp}, chez elle seulement : sa source et ses réglages vivent dans son espace. */
export async function loadHomeApp(ctx: Ctx, appId: number): Promise<AppRow> {
    const row = await loadApp(ctx, appId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'validation',
            'Cette app appartient à un autre espace : elle se règle et se synchronise depuis là-bas.'
        );
    }
    return row;
}

/** Le codec du domicile d'une app visible, celui d'ici pour une app locale. */
export async function appCipher(ctx: Ctx, appId: number): Promise<SdkCipher> {
    return (await ctx.sharing.scope()).cipherFor(String(appId));
}

export async function readApp(cipher: SdkCipher, row: Pick<AppRow, 'content'>): Promise<StoredApp> {
    const stored = await readJson<Partial<StoredApp>>(cipher, row.content);
    return { name: stored?.name ?? '', ratingCountry: stored?.ratingCountry ?? 'FR' };
}

export async function toListing(cipher: SdkCipher, row: ListingRow): Promise<AppStoresListing> {
    const content = await readJson<Partial<StoredListing>>(cipher, row.content);
    const state = (await readJson<ListingState>(cipher, row.state)) ?? {};
    return {
        store: row.store,
        sourceId: row.source_id,
        externalId: content?.externalId ?? '',
        storeName: content?.storeName ?? null,
        bundleId: content?.bundleId ?? null,
        versions: state.versions ?? [],
        rating: typeof state.rating === 'number' ? Math.min(5, Math.max(0, state.rating)) : null,
        ratingCount: typeof state.ratingCount === 'number' ? state.ratingCount : null,
        dataUntil: row.synced_day === null ? null : row.synced_day * DAY_SECONDS,
        lastSyncAt: row.last_sync_at,
        syncError: row.sync_error,
        syncFailure: row.sync_error === null ? null : (state.failure ?? 'other'),
        // Les chiffres ne se disent relevés qu'une fois le rattrapage fini : jusque-là, la colonne reste vide.
        syncing: row.source_id !== null && row.metrics_synced_at === null
    };
}

/** L'icône d'une app, celle de l'App Store d'abord ; `null` avant sa sortie. */
export async function iconOf(cipher: SdkCipher, listings: readonly ListingRow[]): Promise<string | null> {
    for (const store of APP_STORES) {
        const listing = listings.find((l) => l.store === store);
        const state = listing ? await readJson<ListingState>(cipher, listing.state) : null;
        if (typeof state?.icon === 'string') return state.icon;
    }
    return null;
}

export async function toApp(
    cipher: SdkCipher,
    row: AppRow,
    listings: readonly ListingRow[],
    extra: { foreign: boolean; projectCount: number; planPaused: boolean }
): Promise<AppStoresApp> {
    const stored = await readApp(cipher, row);
    const mine = listings.filter((l) => l.app_id === row.id).sort((a, b) => a.store.localeCompare(b.store));
    return appStoresAppSchema.parse({
        id: row.id,
        name: stored.name,
        ratingCountry: stored.ratingCountry,
        icon: await iconOf(cipher, mine),
        listings: await Promise.all(mine.map((l) => toListing(cipher, l))),
        projectCount: extra.projectCount,
        foreign: extra.foreign,
        planPaused: extra.planPaused,
        created: row.created
    });
}

/** Une app relue avec ses fiches et ses projets, pour la rendre après une écriture. */
export async function presentApp(ctx: Ctx, appId: number): Promise<AppStoresApp> {
    const row = await ctx.repo.findVisibleApp(appId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'App introuvable');
    const [listings, counts, cipher] = await Promise.all([
        ctx.repo.listListingsOfApps([appId]),
        projectCountsOf(ctx),
        appCipher(ctx, appId)
    ]);
    return toApp(cipher, row, listings, {
        foreign: row.workspace_id !== ctx.workspaceId,
        projectCount: counts.get(appId) ?? 0,
        planPaused: ctx.quota.isPaused('apps', String(appId))
    });
}

// ----------------------------------------------------------------- les sources

export async function readSource(cipher: SdkCipher, row: Pick<SourceRow, 'content'>): Promise<StoredSource> {
    return (await readJson<StoredSource>(cipher, row.content)) ?? { label: '' };
}

/** Une source telle que le client la voit : jamais son secret, seulement sa présence. */
export async function toSource(cipher: SdkCipher, row: SourceRow, useCount: number): Promise<AppStoresSource> {
    const stored = await readSource(cipher, row);
    const lost = Number(row.failing_count) >= LOST_AFTER_REFUSALS;
    return {
        id: row.id,
        store: row.store,
        label: stored.label,
        issuerId: row.store === 'apple' ? (stored.issuerId ?? null) : null,
        keyId: row.store === 'apple' ? (stored.keyId ?? null) : null,
        vendorNumber: row.store === 'apple' ? (stored.vendorNumber ?? null) : null,
        clientEmail: row.store === 'google' ? (stored.clientEmail ?? null) : null,
        bucket: row.store === 'google' ? (stored.bucket ?? null) : null,
        hasSecret: row.secret_enc.length > 0,
        capabilities: capabilitiesOf(row.capabilities),
        checkedAt: row.checked_at,
        failingSince: lost ? row.failing_since : null,
        failingError: lost ? row.failing_error : null,
        useCount,
        created: row.created
    };
}

// ----------------------------------------------------------------- Projets

/** Le contrat de Projets, relu à l'appel : absent, tout vaut zéro projet. */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/** Combien de projets de l'espace appelant relient chaque app. */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('appstores', ctx.workspaceId)) ?? new Map<number, number>();
}

/** Les projets de l'espace appelant qui relient cette app, à l'étage ouvert. */
export async function projectUsageOf(ctx: Ctx, appId: number): Promise<readonly ProjectUsage[]> {
    return (await projectsProvider(ctx)?.usageOf('appstores', appId, ctx.workspaceId)) ?? [];
}
