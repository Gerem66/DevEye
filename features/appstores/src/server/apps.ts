import {
    appStoresAdd,
    appStoresBackfill,
    appStoresCount,
    appStoresGet,
    appStoresList,
    appStoresRemove,
    appStoresSyncNow,
    appStoresUpdate
} from '../contracts/commands';
import {
    APP_STORES,
    isStoreAppId,
    type AppStore,
    type AppStoresApp,
    type AppStoresAppInput,
    type AppStoresAppSummary,
    type AppStoresListingInput
} from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import type { AppRow, ListingRow } from './repo';
import {
    externalRef,
    loadApp,
    loadHomeApp,
    presentApp,
    projectCountsOf,
    projectUsageOf,
    readApp,
    sealJson,
    syncOf,
    toApp,
    type Ctx,
    type StoredApp,
    type StoredListing
} from './_shared';

/**
 * Les apps de l'espace : une fiche par app, qui porte au plus une présence par
 * store. Rien ici n'appelle un store : l'ajout et la synchronisation à la
 * demande réveillent le service de fond, qui lit et diffuse lui-même.
 */

const DUPLICATE = 'Cette app est déjà suivie dans cet espace.';

const BAD_ID: Record<AppStore, string> = {
    apple: 'L’identifiant d’une app Apple est un nombre : celui de l’adresse de sa fiche App Store (id123456789).',
    google: 'Le nom de paquet d’une app Android ressemble à com.exemple.app : celui de l’adresse de sa fiche Google Play.'
};

const STORE_LABEL: Record<AppStore, string> = { apple: 'App Store', google: 'Google Play' };

/** Les sept derniers jours connus et les sept d'avant, tous stores réunis, alignés sur la donnée de chaque app. */
const SUMMARY_DAYS = 7;

function isDuplicate(e: unknown): boolean {
    return (e as { code?: unknown } | null)?.code === 'ER_DUP_ENTRY';
}

/** La source choisie doit être de cet espace et de ce store : sinon on relierait la clé d'autrui. */
async function checkSource(ctx: Ctx, store: AppStore, sourceId: number | null): Promise<void> {
    if (sourceId === null) return;
    const source = await ctx.repo.findSource(sourceId, ctx.workspaceId);
    if (!source) throw new FeatureError('not_found', 'Source introuvable');
    if (source.store !== store) {
        throw new FeatureError('validation', `Cette source n’est pas un compte ${STORE_LABEL[store]}.`);
    }
}

/** Ce que l'app demande d'un store : un identifiant valide, une source d'ici, une place libre dans l'espace. */
async function checkListing(ctx: Ctx, store: AppStore, input: AppStoresListingInput): Promise<string> {
    if (!isStoreAppId(store, input.externalId)) throw new FeatureError('validation', BAD_ID[store]);
    await checkSource(ctx, store, input.sourceId);
    const ref = externalRef(store, input.externalId);
    if (await ctx.repo.findListingByRef(ctx.workspaceId, ref)) throw new FeatureError('conflict', DUPLICATE);
    return ref;
}

async function createListing(ctx: Ctx, appId: number, store: AppStore, input: AppStoresListingInput, ref: string) {
    const content: StoredListing = { externalId: input.externalId, storeName: null, bundleId: null, sku: null };
    try {
        await ctx.repo.createListing({
            appId,
            workspaceId: ctx.workspaceId,
            store,
            sourceId: input.sourceId,
            externalRef: ref,
            content: await sealJson(ctx.cipher(), content)
        });
    } catch (e) {
        if (isDuplicate(e)) throw new FeatureError('conflict', DUPLICATE);
        throw e;
    }
}

function wanted(input: AppStoresAppInput): [AppStore, AppStoresListingInput | null][] {
    return APP_STORES.map((store) => [store, input[store]]);
}

/** Le dernier jour complet commun aux fiches qui ont des données ; `null` sans aucune. */
export function dataUntilOf(listings: readonly ListingRow[]): number | null {
    const days = listings.flatMap((l) => (l.synced_day === null ? [] : [l.synced_day]));
    return days.length === 0 ? null : Math.min(...days);
}

/**
 * Les téléchargements des sept jours qui finissent à `dataUntil`, et des sept
 * d'avant. Un jour que la fiche ne couvre pas ne compte pas, et une période
 * précédente que l'une des fiches ne couvre pas reste sans écart.
 */
export function summarize(
    listings: readonly ListingRow[],
    rows: readonly { store: AppStore; day: number; downloads: number | null }[]
): { downloads: number | null; previousDownloads: number | null } {
    const withData = listings.filter((l) => l.synced_day !== null && l.history_from !== null);
    const until = dataUntilOf(withData);
    if (until === null) return { downloads: null, previousDownloads: null };
    const covered = (store: AppStore, day: number) =>
        withData.some((l) => l.store === store && (l.history_from ?? Infinity) <= day && day <= (l.synced_day ?? -1));
    const sum = (from: number, to: number) =>
        rows
            .filter((r) => r.day >= from && r.day <= to && covered(r.store, r.day))
            .reduce((total, r) => total + Math.max(0, r.downloads ?? 0), 0);
    const from = until - SUMMARY_DAYS + 1;
    const previousFrom = from - SUMMARY_DAYS;
    const previousCovered = withData.every((l) => (l.history_from ?? Infinity) <= previousFrom);
    return {
        downloads: sum(from, until),
        previousDownloads: previousCovered ? sum(previousFrom, from - 1) : null
    };
}

export const appStoresAppFeatures = [
    defineSdkFeature({
        ...appStoresCount,
        handler: async (ctx: Ctx) => {
            // La carte compte ce que la liste montre : projetées comprises, masquées exclues.
            const rows = await ctx.repo.listVisibleApps(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            return { count: rows.filter((r) => hidden.get(String(r.id)) !== 'none').length };
        }
    }),
    defineSdkFeature({
        ...appStoresList,
        handler: async (ctx: Ctx) => {
            const hidden = await ctx.items.restrictions();
            const rows = (await ctx.repo.listVisibleApps(ctx.workspaceId)).filter(
                (r) => hidden.get(String(r.id)) !== 'none'
            );
            const ids = rows.map((r) => r.id);
            const [shares, counts, listings] = await Promise.all([
                ctx.sharing.scope(),
                projectCountsOf(ctx),
                ctx.repo.listListingsOfApps(ids)
            ]);
            // Une requête par fin de période : d'ordinaire toutes les apps partagent la même.
            const byUntil = new Map<number, number[]>();
            for (const row of rows) {
                const until = dataUntilOf(listings.filter((l) => l.app_id === row.id));
                if (until !== null) byUntil.set(until, [...(byUntil.get(until) ?? []), row.id]);
            }
            const daily = (
                await Promise.all(
                    [...byUntil].map(([until, appIds]) =>
                        ctx.repo.downloadsOf(appIds, until - 2 * SUMMARY_DAYS + 1, until)
                    )
                )
            ).flat();
            const apps: AppStoresAppSummary[] = await Promise.all(
                rows.map(async (row: AppRow) => {
                    const mine = listings.filter((l) => l.app_id === row.id);
                    return {
                        app: await toApp(await shares.cipherFor(String(row.id)), row, mine, {
                            foreign: row.workspace_id !== ctx.workspaceId,
                            projectCount: counts.get(row.id) ?? 0,
                            planPaused: ctx.quota.isPaused('apps', String(row.id))
                        }),
                        ...summarize(
                            mine,
                            daily.filter((d) => d.app_id === row.id)
                        )
                    };
                })
            );
            return { apps };
        }
    }),
    defineSdkFeature({
        ...appStoresGet,
        access: { item: 'appId' },
        handler: async (ctx: Ctx, input) => {
            await loadApp(ctx, input.appId);
            // L'app se lit sous le codec de son domicile ; ses projets sont ceux d'ici.
            const [app, usage] = await Promise.all([presentApp(ctx, input.appId), projectUsageOf(ctx, input.appId)]);
            return { app, usage: usage.map((u) => ({ projectId: u.projectId, title: u.title, status: u.status })) };
        }
    }),
    defineSdkFeature({
        ...appStoresAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const refs = new Map<AppStore, string>();
            for (const [store, listing] of wanted(input)) {
                if (listing) refs.set(store, await checkListing(ctx, store, listing));
            }
            await ctx.quota.assert('apps', async (owned) => (await ctx.repo.countAppsInWorkspaces(owned)) + 1);

            const stored: StoredApp = { name: input.name, ratingCountry: input.ratingCountry };
            const row = await ctx.repo.createApp({
                workspaceId: ctx.workspaceId,
                content: await sealJson(ctx.cipher(), stored)
            });
            try {
                for (const [store, listing] of wanted(input)) {
                    if (listing) await createListing(ctx, row.id, store, listing, refs.get(store) as string);
                }
            } catch (e) {
                // Une app à moitié créée ne doit pas rester : la course perdue se dit en clair.
                await ctx.repo.deleteApp(row.id, ctx.workspaceId);
                throw e;
            }
            ctx.audit({
                action: 'appstores.add',
                description: 'App ajoutée aux Stores',
                metadata: { appId: row.id, stores: [...refs.keys()] }
            });
            syncOf()?.wake();
            return { app: await presentApp(ctx, row.id) };
        }
    }),
    defineSdkFeature({
        ...appStoresUpdate,
        access: { level: 'write', item: 'appId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeApp(ctx, input.appId);
            const cipher = ctx.cipher();
            const current = await readApp(cipher, row);
            const listings = await ctx.repo.listListingsOfApps([row.id]);

            for (const [store, listing] of wanted(input)) {
                const existing = listings.find((l) => l.store === store);
                if (!existing) {
                    if (listing)
                        await createListing(ctx, row.id, store, listing, await checkListing(ctx, store, listing));
                    continue;
                }
                if (!listing) {
                    await ctx.repo.deleteListing(row.id, store);
                    continue;
                }
                if (existing.external_ref !== externalRef(store, listing.externalId)) {
                    throw new FeatureError(
                        'validation',
                        `Une fiche ${STORE_LABEL[store]} garde son app : retirez-la, puis reliez l’autre app.`
                    );
                }
                if (existing.source_id !== listing.sourceId) {
                    await checkSource(ctx, store, listing.sourceId);
                    await ctx.repo.setListingSource(existing.id, listing.sourceId);
                }
            }

            const stored: StoredApp = { name: input.name, ratingCountry: input.ratingCountry };
            await ctx.repo.updateAppContent(row.id, ctx.workspaceId, await sealJson(cipher, stored));
            if (current.ratingCountry !== input.ratingCountry) await ctx.repo.resetRating(row.id);
            syncOf()?.wake();
            return { app: await presentApp(ctx, row.id) };
        }
    }),
    defineSdkFeature({
        ...appStoresRemove,
        access: { level: 'write', item: 'appId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await loadHomeApp(ctx, input.appId);
            // Fiches, chiffres, revenus et avis partent en CASCADE ; les projets
            // ne perdent qu'un pointeur.
            const removed = await ctx.repo.deleteApp(input.appId, ctx.workspaceId);
            if (!removed) throw new FeatureError('not_found', 'App introuvable');
            await ctx.items.forget(String(input.appId));
            ctx.audit({
                action: 'appstores.remove',
                description: 'App retirée des Stores',
                metadata: { appId: input.appId }
            });
            return { appId: input.appId };
        }
    }),
    defineSdkFeature({
        ...appStoresSyncNow,
        // Pas de `mutates` : la commande réveille le service, qui diffusera ce qu'il aura écrit.
        access: { level: 'write', item: 'appId' },
        handler: (ctx: Ctx, input) => requestSync(ctx, input.appId, false)
    }),
    defineSdkFeature({
        ...appStoresBackfill,
        // Pas de `mutates`, comme `syncNow` : le service écrit et diffuse.
        access: { level: 'write', item: 'appId' },
        handler: (ctx: Ctx, input) => requestSync(ctx, input.appId, true)
    })
];

/** Une synchronisation demandée part de chez l'app, active, et d'au moins une fiche reliée à une source. */
async function requestSync(ctx: Ctx, appId: number, history: boolean): Promise<{ app: AppStoresApp }> {
    const row = await loadHomeApp(ctx, appId);
    await ctx.quota.assertActive('apps', String(appId));
    const listings = await ctx.repo.listListingsOfApps([row.id]);
    if (!listings.some((l) => l.source_id !== null)) {
        throw new FeatureError(
            'validation',
            'Aucune fiche de cette app n’a de source : choisissez-en une dans ses réglages.'
        );
    }
    const name = (await readApp(ctx.cipher(), row)).name;
    const launcher = { userId: ctx.userId, workspaceId: ctx.workspaceId, subject: name };
    syncOf()?.requestSync(row.id, launcher, history);
    return { app: await presentApp(ctx, row.id) };
}
