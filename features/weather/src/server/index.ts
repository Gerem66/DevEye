import type { FeatureServer } from '@deveye/types/sdk/server';

import { WEATHER_ENV } from './env';
import { weatherHandlers } from './handlers';
import { createRepo, type WeatherRepo } from './repo';
import { weatherAccountExport } from './accountExport';

/**
 * Pas de `migrationsDir` : les tables de Météo sont dans le socle ; une nouvelle
 * table irait dans `src/server/migrations/` avec le préfixe `ft_weather_`.
 */
export const serverEntry: FeatureServer<WeatherRepo> = {
    createRepo,
    env: WEATHER_ENV,
    features: weatherHandlers,
    accountExport: weatherAccountExport
};
