import type { FeatureClient } from 'deveye-types/sdk/client';

import Weather, { WeatherWidget } from './Weather';
import WeatherKeysPanel from './WeatherKeysPanel';

/** Le glyphe météo, aussi consommé par le widget de topbar de l'app. */
export { wmoIcon } from './wmoIcon';

export const clientEntry: FeatureClient = {
    Widget: WeatherWidget,
    Full: Weather,
    settingsPanels: { sources: WeatherKeysPanel },
    cacheDurationMinutes: 60,
    preload: true
};
