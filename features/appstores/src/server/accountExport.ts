import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { AppStoresRepo } from './repo';

const OF_APPS = 'app_id IN (SELECT id FROM ft_appstores_apps WHERE workspace_id = ?)';

const IMPORTED =
    'est un historique importé des stores, qui le gardent : la synchronisation le relit chez Apple et Google.';

export const appStoresAccountExport: FeatureAccountExport<AppStoresRepo> = {
    tables: {
        // Le contenu ne porte que l'identité de la clé ; la clé privée ne sort jamais.
        ft_appstores_sources: {
            file: 'sources.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { checked_at: 's', failing_since: 's', created: 's' },
            omit: ['secret_enc']
        },
        ft_appstores_apps: {
            file: 'apps.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        // `state` n'est que ce que la synchronisation relit chez le store (versions, note, curseurs).
        ft_appstores_listings: {
            file: 'fiches.json',
            where: OF_APPS,
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: {
                metrics_synced_at: 's',
                reviews_synced_at: 's',
                rating_synced_at: 's',
                last_sync_at: 's',
                created: 's'
            },
            omit: ['state']
        },
        // Les avis portent les réponses publiées par le compte.
        ft_appstores_reviews: {
            file: 'avis.json',
            where: OF_APPS,
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created_at: 's', replied_at: 's' }
        },
        ft_appstores_daily: { skip: `Le relevé quotidien (téléchargements, notes, stabilité) ${IMPORTED}` },
        ft_appstores_countries: { skip: `Le relevé des téléchargements par pays ${IMPORTED}` },
        ft_appstores_revenue: { skip: `Le relevé des revenus ${IMPORTED}` }
    }
};
