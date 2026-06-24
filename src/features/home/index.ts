import type { FeatureDefinition } from '../_define';
import { homeSetLayoutFeature } from './setLayout';
import { homeShortcutPreviewFeature } from './shortcutPreview';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const homeFeatures: FeatureDefinition<string, any, any>[] = [homeSetLayoutFeature, homeShortcutPreviewFeature];
