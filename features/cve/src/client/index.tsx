import type { FeatureClient } from '@deveye/types/sdk/client';

import Cve from './Cve';
import CveKeysPanel from './CveKeysPanel';
import DetectionPanel from './DetectionPanel';
import ExposureWidget from './ExposureWidget';

export const clientEntry: FeatureClient = {
    Widget: ExposureWidget,
    Full: Cve,
    settingsPanels: { detection: DetectionPanel, sources: CveKeysPanel },
    cacheDurationMinutes: 30,
    preload: true
};
