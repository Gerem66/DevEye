import type { FeatureClient } from '@deveye/types/sdk/client';

import Finance from './Finance';
import FinanceCategoriesPanel from './FinanceCategoriesPanel';
import FinanceGeneralPanel from './FinanceGeneralPanel';
import FinanceWidget from './FinanceWidget';

export const clientEntry: FeatureClient = {
    Widget: FinanceWidget,
    Full: Finance,
    settingsPanels: { general: FinanceGeneralPanel, categories: FinanceCategoriesPanel },
    // Démonté dès la fermeture, comme le journal des bases : le journal des
    // opérations tient une page bornée par une période et des filtres qui
    // n'ont aucune raison de survivre à la fermeture de l'écran, et les
    // soldes d'une instance en cache auraient vieilli en silence. Pas de
    // `holdSecrecy` : rien n'y est chiffré à l'étage gardé, donc rien ne
    // peut déclencher l'invite de mot de passe.
    cacheDurationMinutes: 0
};
