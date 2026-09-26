import type { FeatureClient } from '@deveye/types/sdk/client';

import Finance from './Finance';
import FinanceCategoriesPanel from './FinanceCategoriesPanel';
import FinanceRulesPanel from './FinanceRulesPanel';
import FinanceWidget from './FinanceWidget';
import GeneralPanel from './GeneralPanel';

export const clientEntry: FeatureClient = {
    Widget: FinanceWidget,
    Full: Finance,
    settingsPanels: { general: GeneralPanel, categories: FinanceCategoriesPanel, rules: FinanceRulesPanel },
    // Démonté dès la fermeture : les filtres du journal n'ont pas à survivre,
    // et les soldes en cache vieilliraient. Pas de `holdSecrecy` : rien n'est
    // chiffré à l'étage gardé.
    cacheDurationMinutes: 0
};
