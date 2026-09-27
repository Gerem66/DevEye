import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { WeatherRepo } from './repo';

export const weatherAccountExport: FeatureAccountExport<WeatherRepo> = {
    tables: {
        weather_locations: {
            file: 'villes.json',
            where: 'workspace_id = ?',
            key: ['position', 'id'],
            dates: { created: 's' }
        },
        weather_provider_keys: { skip: 'Les clés d’API des fournisseurs météo ne sortent jamais.' }
    }
};
