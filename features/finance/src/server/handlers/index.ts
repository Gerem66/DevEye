import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import type { FinanceRepo } from '../repo';
import {
    financeAccountAddFeature,
    financeAccountListFeature,
    financeAccountRemoveFeature,
    financeAccountReorderFeature,
    financeAccountUpdateFeature
} from './accounts';
import {
    financeCategoryAddFeature,
    financeCategoryListFeature,
    financeCategoryRemoveFeature,
    financeCategoryUpdateFeature
} from './categories';
import { financeConfigFeature, financeConfigUpdateFeature, financeSummaryFeature } from './config';
import { financeOverviewFeature } from './overview';
import {
    financeRecurringAddFeature,
    financeRecurringListFeature,
    financeRecurringPostFeature,
    financeRecurringRemoveFeature,
    financeRecurringSkipFeature,
    financeRecurringUpdateFeature
} from './recurring';
import {
    financeTransactionAddFeature,
    financeTransactionListFeature,
    financeTransactionRemoveFeature,
    financeTransactionSetClearedFeature,
    financeTransactionUpdateFeature
} from './transactions';

/**
 * Préfixe `finance.` et verbes en camelCase : le filet `MUTATION_VERB` de
 * `_topics.ts` ne voit aucune de ces commandes, donc les `mutates` se relisent
 * à la main. Toute lecture qui montre un montant appelle `postDueRecurring`
 * en tête (voir `_shared.ts`), sinon elle montrerait un état d'avant les
 * échéances du jour.
 */
export const financeHandlers: ReadonlyArray<SdkFeatureDefinition<FinanceRepo>> = [
    financeConfigFeature,
    financeConfigUpdateFeature,
    financeSummaryFeature,
    financeAccountListFeature,
    financeAccountAddFeature,
    financeAccountUpdateFeature,
    financeAccountRemoveFeature,
    financeAccountReorderFeature,
    financeCategoryListFeature,
    financeCategoryAddFeature,
    financeCategoryUpdateFeature,
    financeCategoryRemoveFeature,
    financeTransactionListFeature,
    financeTransactionAddFeature,
    financeTransactionUpdateFeature,
    financeTransactionRemoveFeature,
    financeTransactionSetClearedFeature,
    financeRecurringListFeature,
    financeRecurringAddFeature,
    financeRecurringUpdateFeature,
    financeRecurringRemoveFeature,
    financeRecurringPostFeature,
    financeRecurringSkipFeature,
    financeOverviewFeature
];
