import type { FeatureClient } from '@deveye/types/sdk/client';

import Convert from './Convert';
import { ConvertWidget } from './ConvertWidget';
import GeneralPanel from './GeneralPanel';

export const clientEntry: FeatureClient = {
    Widget: ConvertWidget,
    Full: Convert,
    settingsPanels: { general: GeneralPanel },
    // Un travail avance tout seul : la vue ne doit jamais montrer un état mis en cache.
    cacheDurationMinutes: 0
};
