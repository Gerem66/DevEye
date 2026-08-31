import type { FeatureClient } from '@deveye/types/sdk/client';

import Cve, { CveWidget } from './Cve';
import CveKeysPanel from './CveKeysPanel';

export const clientEntry: FeatureClient = {
    Widget: CveWidget,
    Full: Cve,
    settingsPanels: { sources: CveKeysPanel },
    cacheDurationMinutes: 30,
    preload: true
};
