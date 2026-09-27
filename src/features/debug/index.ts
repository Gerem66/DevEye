import type { FeatureDefinition } from '../_define';
import { debugBenchCatalogFeature, debugBenchStartFeature, debugPingFeature } from './bench';
import { debugE2eCatalogFeature, debugE2eStartFeature, debugE2eSweepFeature } from './e2e';
import { debugMailCatalogFeature, debugMailPreviewFeature, debugMailSendFeature } from './mail';
import {
    debugTrackingClearFeature,
    debugTrackingCreateFeature,
    debugTrackingGetFeature,
    debugTrackingSetFeature,
    debugTrackingUseFeature
} from './tracking';
import { debugOverviewFeature, debugRunAbortFeature, debugRunGetFeature, debugRunListFeature } from './runs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const debugFeatures: FeatureDefinition<string, any, any>[] = [
    debugOverviewFeature,
    debugRunGetFeature,
    debugRunListFeature,
    debugRunAbortFeature,
    debugE2eCatalogFeature,
    debugE2eStartFeature,
    debugE2eSweepFeature,
    debugBenchCatalogFeature,
    debugBenchStartFeature,
    debugPingFeature,
    debugMailCatalogFeature,
    debugMailPreviewFeature,
    debugMailSendFeature,
    debugTrackingGetFeature,
    debugTrackingCreateFeature,
    debugTrackingUseFeature,
    debugTrackingSetFeature,
    debugTrackingClearFeature
];
