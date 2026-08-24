import type { FeatureClient } from '@deveye/types/sdk/client';

import Weather, { WeatherWidget } from './Weather';
import WeatherTopbarWidget from './TopbarWidget';
import WeatherKeysPanel from './WeatherKeysPanel';

export const clientEntry: FeatureClient = {
    Widget: WeatherWidget,
    Full: Weather,
    settingsPanels: { sources: WeatherKeysPanel },
    TopbarWidget: WeatherTopbarWidget,
    cacheDurationMinutes: 60,
    preload: true
};
