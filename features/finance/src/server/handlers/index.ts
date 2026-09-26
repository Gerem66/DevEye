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
import {
    financeConfigFeature,
    financeInvoicingLinkFeature,
    financeStatusSetFeature,
    financeSummaryFeature
} from './config';
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
    financeAccountBankLinkFeature,
    financeBankListFeature,
    financeConnectionAddQontoFeature,
    financeConnectionListFeature,
    financeConnectionRemoveFeature,
    financeConnectionStartFeature,
    financeConnectionSyncFeature,
    financeConnectionUpdateFeature
} from './connections';
import {
    financeImportMappingFeature,
    financeRuleListFeature,
    financeRuleRemoveFeature,
    financeRuleSaveFeature,
    financeStatementImportFeature,
    financeStatementListFeature,
    financeStatementResolveFeature
} from './statements';
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
 * à la main. Toute lecture qui montre un montant appelle `catchUp` en tête
 * (voir `sources.ts`), sinon elle montrerait un état d'avant les échéances du
 * jour et les derniers règlements de Facturation.
 */
export const financeHandlers: ReadonlyArray<SdkFeatureDefinition<FinanceRepo>> = [
    financeConfigFeature,
    financeInvoicingLinkFeature,
    financeStatusSetFeature,
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
    financeStatementImportFeature,
    financeImportMappingFeature,
    financeStatementListFeature,
    financeStatementResolveFeature,
    financeRuleListFeature,
    financeRuleSaveFeature,
    financeRuleRemoveFeature,
    financeConnectionListFeature,
    financeConnectionAddQontoFeature,
    financeConnectionUpdateFeature,
    financeConnectionRemoveFeature,
    financeConnectionSyncFeature,
    financeBankListFeature,
    financeConnectionStartFeature,
    financeAccountBankLinkFeature,
    financeOverviewFeature
];
