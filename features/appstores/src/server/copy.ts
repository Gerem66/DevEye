import { APPSTORES_APP_NAME_MAX_LENGTH, COUNTRY_CODE, isStoreAppId, type AppStore } from '../contracts/domain';
import { FeatureError, type FeatureItemsCopy, type ItemTree } from '@deveye/types/sdk/server';

import type { AppStoresRepo } from './repo';
import { LISTING_DIGEST, REVIEW_DIGEST, type StoredApp, type StoredListing } from './_shared';

/**
 * Ce dont une app est faite : sa ligne, ses fiches de store, et les avis que
 * la synchronisation a relevés. Les chiffres du jour, leurs pays et les
 * revenus restent hors de l'arbre : ils suivent `app_id` dans un déplacement, et une copie ne
 * les emporte pas, car elle passe par le navigateur de quelqu'un qui peut lire
 * l'app sans tenir le droit Revenus.
 *
 * ⚠️ À tenir à jour : toute colonne chiffrée qui pend à une app doit figurer
 * dans `sealed`, sinon un déplacement la laisse illisible sous l'ancienne clé.
 */
export const DUPLICATE = 'Cette app est déjà suivie dans cet espace.';

export const appStoresTree: ItemTree = [
    {
        table: 'ft_appstores_apps',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        orderColumn: 'sort_order',
        sealed: ['content'],
        omit: ['created']
    },
    {
        table: 'ft_appstores_listings',
        idColumn: 'id',
        ownerColumn: 'app_id',
        workspaceColumn: 'workspace_id',
        unique: { column: 'external_ref', message: DUPLICATE },
        sealed: ['content', 'state'],
        digests: [LISTING_DIGEST],
        // La source appartient à l'espace quitté ; l'état et la couverture, à ce que ce serveur a relu.
        omit: [
            'source_id',
            'state',
            'history_from',
            'synced_day',
            'metrics_synced_at',
            'reviews_synced_at',
            'rating_synced_at',
            'last_sync_at',
            'sync_error',
            'created'
        ]
    },
    {
        table: 'ft_appstores_reviews',
        idColumn: 'id',
        ownerColumn: 'app_id',
        sealed: ['content'],
        digests: [REVIEW_DIGEST],
        cache: true
    }
];

const invalid = (message: string) => new FeatureError('validation', message);

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

export const appStoresCopy: FeatureItemsCopy<AppStoresRepo> = {
    tree: appStoresTree,
    async plan({ q, itemId }) {
        const sourced = await q.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM ft_appstores_listings WHERE app_id = ? AND source_id IS NOT NULL',
            [Number(itemId)]
        );
        return {
            blockers: [],
            drops: [
                ...(Number(sourced[0]?.n ?? 0) > 0
                    ? ['Sa source, qui reste dans cet espace : il faudra en choisir une là-bas pour synchroniser']
                    : []),
                'Ses chiffres, ses revenus et ses avis, que la copie relira chez les stores une fois sa source choisie : Apple remonte un an, Google ne rend que les avis des sept derniers jours'
            ]
        };
    },
    /** Rien de ce qui arrive n'est cru : l'identité au store se relit, et le moteur en tire le condensé de l'arrivée. */
    async admit({ repo, quota, rows }) {
        await quota.assert('apps', async (owned) => (await repo.countAppsInWorkspaces(owned)) + 1);

        for (const app of rows.ft_appstores_apps ?? []) {
            let stored: Partial<StoredApp> | null = null;
            try {
                stored = JSON.parse(String(app.content)) as Partial<StoredApp>;
            } catch {
                throw invalid('L’app copiée ne se lit pas.');
            }
            const name = text(stored?.name)?.trim().slice(0, APPSTORES_APP_NAME_MAX_LENGTH) ?? 'App';
            const country = text(stored?.ratingCountry);
            const sanitized: StoredApp = {
                name,
                ratingCountry: country && COUNTRY_CODE.test(country) ? country : 'FR'
            };
            app.content = JSON.stringify(sanitized);
        }

        const stores = new Set<AppStore>();
        for (const listing of rows.ft_appstores_listings ?? []) {
            const store = listing.store;
            if (store !== 'apple' && store !== 'google')
                throw invalid('Une fiche de store inattendue arrive avec la copie.');
            if (stores.has(store)) throw invalid('La copie porte deux fiches pour le même store.');
            stores.add(store);
            let stored: Partial<StoredListing> | null = null;
            try {
                stored = JSON.parse(String(listing.content)) as Partial<StoredListing>;
            } catch {
                throw invalid('Une fiche de store de la copie ne se lit pas.');
            }
            const externalId = text(stored?.externalId);
            if (externalId === null || !isStoreAppId(store, externalId)) {
                throw invalid('Une fiche de store de la copie porte un identifiant invalide.');
            }
            const clean: StoredListing = {
                externalId,
                storeName: text(stored?.storeName),
                bundleId: text(stored?.bundleId),
                sku: text(stored?.sku)
            };
            listing.content = JSON.stringify(clean);
        }
    }
};
