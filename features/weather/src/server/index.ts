import type { FeatureServer } from '@deveye/types/sdk/server';

import { weatherHandlers } from './handlers';
import { createRepo, type WeatherRepo } from './repo';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : les tables de Météo
 * datent du socle (007/008/011/051) et n'en bougeront jamais ; une nouvelle
 * table du module inaugurera `src/server/migrations/` avec le préfixe
 * `ft_weather_`.
 */
export const serverEntry: FeatureServer<WeatherRepo> = {
    createRepo,
    features: weatherHandlers
};
