import type { FeatureClient } from '@deveye/types/sdk/client';

import Invoicing from './Invoicing';
import { InvoicingWidget } from './InvoicingWidget';
import GeneralPanel from './GeneralPanel';
import NumberingPanel from './NumberingPanel';
import TaxesPanel from './TaxesPanel';
import WordingPanel from './WordingPanel';

/**
 * Pas d'`Art` : l'id est natif, donc sa vignette vit avec celles de ses voisines
 * (`client/src/Pages/Home/art/FeatureArt.tsx`), au même trait et sur la même
 * palette. `Art` est la porte des modules externes, que cette table ne connaît
 * pas.
 */
export const clientEntry: FeatureClient = {
    Widget: InvoicingWidget,
    Full: Invoicing,
    settingsPanels: {
        general: GeneralPanel,
        taxes: TaxesPanel,
        numbering: NumberingPanel,
        wording: WordingPanel
    },
    // Les filtres du journal n'ont pas à survivre, et un brouillon gardé en
    // cache vieillirait sous les doigts d'un autre membre.
    cacheDurationMinutes: 0
};
