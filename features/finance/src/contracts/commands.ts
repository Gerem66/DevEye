import { z } from 'zod';
import {
    FINANCE_COUNTERPARTY_MAX_LENGTH,
    FINANCE_LABEL_MAX_LENGTH,
    FINANCE_NAME_MAX_LENGTH,
    FINANCE_NOTE_MAX_LENGTH,
    financeAccountKindSchema,
    financeAccountSchema,
    financeAmountSchema,
    financeBalanceSchema,
    financeBudgetPeriodSchema,
    financeBudgetSchema,
    financeCategorySchema,
    financeColorSchema,
    financeConfigSchema,
    financeDateSchema,
    financeFlowSchema,
    financeFrequencySchema,
    financeOverviewSchema,
    financeRangeSchema,
    financeRecurringSchema,
    financeSummarySchema,
    financeTransactionKindSchema,
    financeTransactionSchema
} from './domain';
/**
 * Commandes des finances de l'espace.
 *
 * L'espace visé n'apparaît dans aucune entrée: il voyage sur l'enveloppe WS
 * (voir `protocol/envelope`) et le dispatcheur le résout avant le handler.
 *
 * ⚠️ Préfixe unique `finance.` et verbes en camelCase, comme `git`, `database`
 * et `audience`: le filet `MUTATION_VERB` de `_topics.ts` ne voit **aucune** de
 * ces commandes, donc les `mutates` du serveur se relisent à la main. Les huit
 * lectures sont `config`, `summary`, `accountList`, `categoryList`,
 * `transactionList`, `budgetList`, `recurringList` et `overview`; tout le reste
 * écrit.
 */
const accountId = z.number().int().positive();
const categoryId = z.number().int().positive();
const transactionId = z.number().int().positive();
const budgetId = z.number().int().positive();
const recurringId = z.number().int().positive();
/* ------------------------------------------------------------------ *
 * Réglages
 * ------------------------------------------------------------------ */
/**
 * Les réglages de l'espace. Jamais gardés derrière un droit d'écriture: toute
 * lecture en a besoin (ne serait-ce que pour formater un montant), et la
 * première ouverture de la feature crée la ligne par défaut si elle manque.
 */
export const financeConfig = {
    command: 'finance.config' as const,
    input: z.object({}),
    output: z.object({ config: financeConfigSchema })
};
export const financeConfigUpdate = {
    command: 'finance.configUpdate' as const,
    input: z.object({ config: financeConfigSchema }),
    output: z.object({ config: financeConfigSchema })
};
/** Ce que lit la carte de l'accueil, et rien de plus. */
export const financeSummary = {
    command: 'finance.summary' as const,
    input: z.object({}),
    output: z.object({ summary: financeSummarySchema })
};
/* ------------------------------------------------------------------ *
 * Comptes
 * ------------------------------------------------------------------ */
const accountDraftSchema = z.object({
    name: z.string().min(1).max(FINANCE_NAME_MAX_LENGTH),
    kind: financeAccountKindSchema,
    color: financeColorSchema,
    initialBalance: financeBalanceSchema,
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    archived: z.boolean()
});
/**
 * Les comptes de l'espace, soldes compris. `archived` inclut ceux qu'on a mis
 * de côté; sans lui la liste ne rend que les comptes vivants, ce dont ont besoin
 * tous les sélecteurs.
 */
export const financeAccountList = {
    command: 'finance.accountList' as const,
    input: z.object({ archived: z.boolean().optional() }),
    output: z.object({ accounts: z.array(financeAccountSchema) })
};
export const financeAccountAdd = {
    command: 'finance.accountAdd' as const,
    input: z.object({ account: accountDraftSchema }),
    output: z.object({ account: financeAccountSchema })
};
export const financeAccountUpdate = {
    command: 'finance.accountUpdate' as const,
    input: z.object({ accountId, account: accountDraftSchema }),
    output: z.object({ account: financeAccountSchema })
};
/**
 * Supprime un compte. Refusé (`conflict`) tant qu'il porte des opérations: les
 * effacer avec lui ferait disparaître de l'argent d'un livre de comptes sans
 * autre trace, et le seul geste réversible existe déjà (l'archivage).
 */
export const financeAccountRemove = {
    command: 'finance.accountRemove' as const,
    input: z.object({ accountId }),
    output: z.object({ accountId })
};
export const financeAccountReorder = {
    command: 'finance.accountReorder' as const,
    input: z.object({ accountIds: z.array(accountId).min(1) }),
    output: z.object({ accountIds: z.array(accountId) })
};
/* ------------------------------------------------------------------ *
 * Catégories
 * ------------------------------------------------------------------ */
const categoryDraftSchema = z.object({
    name: z.string().min(1).max(FINANCE_NAME_MAX_LENGTH),
    flow: financeFlowSchema,
    color: financeColorSchema,
    icon: z.string().max(40)
});
export const financeCategoryList = {
    command: 'finance.categoryList' as const,
    input: z.object({}),
    output: z.object({ categories: z.array(financeCategorySchema) })
};
export const financeCategoryAdd = {
    command: 'finance.categoryAdd' as const,
    input: z.object({ category: categoryDraftSchema }),
    output: z.object({ category: financeCategorySchema })
};
export const financeCategoryUpdate = {
    command: 'finance.categoryUpdate' as const,
    input: z.object({ categoryId, category: categoryDraftSchema }),
    output: z.object({ category: financeCategorySchema })
};
/**
 * Supprime une catégorie. Les opérations qu'elle classait ne sont pas touchées:
 * elles retombent simplement dans « Sans catégorie » (`ON DELETE SET NULL`).
 * Les budgets posés dessus, eux, disparaissent avec elle: une enveloppe sans
 * catégorie ne veut plus rien dire.
 */
export const financeCategoryRemove = {
    command: 'finance.categoryRemove' as const,
    input: z.object({ categoryId }),
    output: z.object({ categoryId })
};
export const financeCategoryReorder = {
    command: 'finance.categoryReorder' as const,
    input: z.object({ categoryIds: z.array(categoryId).min(1) }),
    output: z.object({ categoryIds: z.array(categoryId) })
};
/* ------------------------------------------------------------------ *
 * Opérations
 * ------------------------------------------------------------------ */
const transactionDraftSchema = z.object({
    accountId,
    kind: financeTransactionKindSchema,
    amount: financeAmountSchema,
    date: financeDateSchema,
    label: z.string().max(FINANCE_LABEL_MAX_LENGTH),
    categoryId: categoryId.nullable(),
    transferAccountId: accountId.nullable(),
    counterparty: z.string().max(FINANCE_COUNTERPARTY_MAX_LENGTH),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    vatAmount: financeAmountSchema.nullable(),
    cleared: z.boolean()
});
/**
 * Le journal, filtré et paginé.
 *
 * Toute la sélection est faite en SQL sur des colonnes en clair. La **recherche
 * textuelle** n'y figure pas et ne peut pas y figurer: l'intitulé et le tiers
 * sont chiffrés, donc aucun `LIKE` ne les atteint. Le client filtre ce qu'il a
 * chargé, ce qui est honnête tant que la fenêtre est bornée par une période.
 *
 * `totals` porte les sommes de l'**ensemble** du filtre, pas de la page: sans
 * ça, un total qui ne compte que 50 lignes sur 300 induit en erreur.
 */
export const financeTransactionList = {
    command: 'finance.transactionList' as const,
    input: z.object({
        accountId: accountId.optional(),
        categoryId: categoryId.optional(),
        kind: financeTransactionKindSchema.optional(),
        /** Premier jour compris. */
        from: financeDateSchema.optional(),
        /** Dernier jour compris. */
        to: financeDateSchema.optional(),
        /** Ne rendre que les non pointées, ou que les pointées. */
        cleared: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional()
    }),
    output: z.object({
        transactions: z.array(financeTransactionSchema),
        /** Nombre total de lignes correspondant au filtre, toutes pages confondues. */
        total: z.number().int().nonnegative(),
        totals: z.object({
            income: financeAmountSchema,
            expense: financeAmountSchema,
            net: financeBalanceSchema
        })
    })
};
export const financeTransactionAdd = {
    command: 'finance.transactionAdd' as const,
    input: z.object({ transaction: transactionDraftSchema }),
    output: z.object({ transaction: financeTransactionSchema })
};
export const financeTransactionUpdate = {
    command: 'finance.transactionUpdate' as const,
    input: z.object({ transactionId, transaction: transactionDraftSchema }),
    output: z.object({ transaction: financeTransactionSchema })
};
export const financeTransactionRemove = {
    command: 'finance.transactionRemove' as const,
    input: z.object({ transactionId }),
    output: z.object({ transactionId })
};
/**
 * Pointe ou dépointe une opération, sans toucher au reste.
 *
 * Commande à part plutôt qu'un passage par `transactionUpdate`: pointer est un
 * clic sur une ligne, répété des dizaines de fois d'affilée au moment du
 * rapprochement bancaire. Le faire passer par la modification complète
 * imposerait de déchiffrer puis rechiffrer le contenu à chaque clic, pour un
 * booléen qui est en clair.
 */
export const financeTransactionSetCleared = {
    command: 'finance.transactionSetCleared' as const,
    input: z.object({
        transactionIds: z.array(transactionId).min(1).max(500),
        cleared: z.boolean()
    }),
    output: z.object({ transactionIds: z.array(transactionId), cleared: z.boolean() })
};
/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */
export const financeBudgetList = {
    command: 'finance.budgetList' as const,
    input: z.object({}),
    output: z.object({ budgets: z.array(financeBudgetSchema) })
};
/**
 * Pose ou remplace l'enveloppe d'une catégorie. Une seule par catégorie, d'où
 * un `budgetSet` plutôt qu'un couple ajout / modification: deux enveloppes sur
 * la même catégorie n'auraient aucun sens et il faudrait ensuite les départager.
 */
export const financeBudgetSet = {
    command: 'finance.budgetSet' as const,
    input: z.object({ categoryId, amount: financeAmountSchema, period: financeBudgetPeriodSchema }),
    output: z.object({ budget: financeBudgetSchema })
};
export const financeBudgetRemove = {
    command: 'finance.budgetRemove' as const,
    input: z.object({ budgetId }),
    output: z.object({ budgetId })
};
/* ------------------------------------------------------------------ *
 * Échéances
 * ------------------------------------------------------------------ */
const recurringDraftSchema = z.object({
    accountId,
    kind: financeTransactionKindSchema,
    amount: financeAmountSchema,
    label: z.string().max(FINANCE_LABEL_MAX_LENGTH),
    categoryId: categoryId.nullable(),
    transferAccountId: accountId.nullable(),
    counterparty: z.string().max(FINANCE_COUNTERPARTY_MAX_LENGTH),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    vatAmount: financeAmountSchema.nullable(),
    frequency: financeFrequencySchema,
    interval: z.number().int().positive().max(60),
    nextDate: financeDateSchema,
    endDate: financeDateSchema.nullable(),
    automatic: z.boolean(),
    active: z.boolean()
});
export const financeRecurringList = {
    command: 'finance.recurringList' as const,
    input: z.object({}),
    output: z.object({ recurrings: z.array(financeRecurringSchema) })
};
export const financeRecurringAdd = {
    command: 'finance.recurringAdd' as const,
    input: z.object({ recurring: recurringDraftSchema }),
    output: z.object({ recurring: financeRecurringSchema })
};
export const financeRecurringUpdate = {
    command: 'finance.recurringUpdate' as const,
    input: z.object({ recurringId, recurring: recurringDraftSchema }),
    output: z.object({ recurring: financeRecurringSchema })
};
/**
 * Supprime l'échéance. Les opérations déjà écrites par elle restent: elles ont
 * eu lieu. Elles perdent seulement leur rattachement (`ON DELETE SET NULL`).
 */
export const financeRecurringRemove = {
    command: 'finance.recurringRemove' as const,
    input: z.object({ recurringId }),
    output: z.object({ recurringId })
};
/**
 * Écrit maintenant l'occurrence attendue, et avance la date de la suivante.
 * C'est le clic que réclame une échéance non automatique. `amount` permet de
 * corriger au passage le montant d'une facture qui varie, sans toucher au
 * modèle lui-même.
 */
export const financeRecurringPost = {
    command: 'finance.recurringPost' as const,
    input: z.object({ recurringId, amount: financeAmountSchema.optional() }),
    output: z.object({ transaction: financeTransactionSchema, recurring: financeRecurringSchema })
};
/** Passe l'occurrence attendue sans rien écrire, et avance à la suivante. */
export const financeRecurringSkip = {
    command: 'finance.recurringSkip' as const,
    input: z.object({ recurringId }),
    output: z.object({ recurring: financeRecurringSchema })
};
/* ------------------------------------------------------------------ *
 * Tableau de bord
 * ------------------------------------------------------------------ */
export const financeOverview = {
    command: 'finance.overview' as const,
    input: z.object({ range: financeRangeSchema }),
    output: z.object({ overview: financeOverviewSchema })
};
export const financeCommands = [
    financeConfig,
    financeConfigUpdate,
    financeSummary,
    financeAccountList,
    financeAccountAdd,
    financeAccountUpdate,
    financeAccountRemove,
    financeAccountReorder,
    financeCategoryList,
    financeCategoryAdd,
    financeCategoryUpdate,
    financeCategoryRemove,
    financeCategoryReorder,
    financeTransactionList,
    financeTransactionAdd,
    financeTransactionUpdate,
    financeTransactionRemove,
    financeTransactionSetCleared,
    financeBudgetList,
    financeBudgetSet,
    financeBudgetRemove,
    financeRecurringList,
    financeRecurringAdd,
    financeRecurringUpdate,
    financeRecurringRemove,
    financeRecurringPost,
    financeRecurringSkip,
    financeOverview
] as const;
