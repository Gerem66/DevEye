import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import type { FinanceRepo } from '../repo';
import {
    financeAccountAddFeature,
    financeAccountListFeature,
    financeAccountRemoveFeature,
    financeAccountReorderFeature,
    financeAccountUpdateFeature
} from './accounts';
import { financeBudgetListFeature, financeBudgetRemoveFeature, financeBudgetSetFeature } from './budgets';
import {
    financeCategoryAddFeature,
    financeCategoryListFeature,
    financeCategoryRemoveFeature,
    financeCategoryReorderFeature,
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
 * Les finances de l'espace: comptes, opérations, budgets, échéances.
 *
 * Sept fichiers, sept natures. `../_shared.ts` porte le socle (chiffre,
 * calendrier, cohérence d'une saisie, rattrapage des échéances); `config.ts`
 * les réglages et la carte de l'accueil; `accounts.ts`, `categories.ts`,
 * `transactions.ts`, `budgets.ts` et `recurring.ts` chacun leur objet;
 * `overview.ts` ne fait que lire, en composant les agrégats des autres.
 *
 * ⚠️ Préfixe unique `finance.` et verbes en camelCase, comme `git`, `database`
 * et `audience`: le filet `MUTATION_VERB` de `_topics.ts` ne voit **aucune** de
 * ces commandes, donc les `mutates` se relisent à la main. Vingt écritures le
 * déclarent, et les huit lectures (`config`, `summary`, `accountList`,
 * `categoryList`, `transactionList`, `budgetList`, `recurringList`, `overview`)
 * n'en déclarent aucune, ce qui est juste.
 *
 * ⚠️ Les six lectures qui montrent des montants appellent `postDueRecurring` en
 * tête. C'est ce qui remplace la tâche de fond des échéances automatiques (voir
 * `_shared.ts`). En ajoutant une lecture qui montre un solde, un journal ou un
 * budget, il faut l'appeler aussi, sans quoi elle montrera un état d'avant les
 * échéances du jour. `config` et `categoryList` s'en passent: aucune des deux ne
 * porte de montant.
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
    financeCategoryReorderFeature,
    financeTransactionListFeature,
    financeTransactionAddFeature,
    financeTransactionUpdateFeature,
    financeTransactionRemoveFeature,
    financeTransactionSetClearedFeature,
    financeBudgetListFeature,
    financeBudgetSetFeature,
    financeBudgetRemoveFeature,
    financeRecurringListFeature,
    financeRecurringAddFeature,
    financeRecurringUpdateFeature,
    financeRecurringRemoveFeature,
    financeRecurringPostFeature,
    financeRecurringSkipFeature,
    financeOverviewFeature
];
