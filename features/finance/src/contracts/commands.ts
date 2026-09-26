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
 * Commandes des finances. Préfixe `finance.` et verbes en camelCase : le filet
 * `MUTATION_VERB` de `_topics.ts` ne voit aucune de ces commandes, donc les
 * `mutates` du serveur se relisent à la main.
 */
const accountId = z.number().int().positive();
const categoryId = z.number().int().positive();
const transactionId = z.number().int().positive();
const recurringId = z.number().int().positive();
/** Jamais derrière un droit d'écriture : toute lecture en a besoin, ne serait-ce que pour formater un montant. */
export const financeConfig = {
    command: 'finance.config' as const,
    input: z.object({}),
    output: z.object({ config: financeConfigSchema })
};
/**
 * Le compte qui reçoit les règlements de Facturation, et la catégorie où ils se
 * rangent. `accountId` à `null` coupe l'arrivée ; `categoryId` à `null` range
 * dans « Prestations », créée au besoin.
 */
export const financeInvoicingLink = {
    command: 'finance.invoicingLink' as const,
    input: z.object({ accountId: accountId.nullable(), categoryId: categoryId.nullable() }),
    output: z.object({ config: financeConfigSchema })
};
/** Ce que lit la carte de l'accueil, et rien de plus. */
export const financeSummary = {
    command: 'finance.summary' as const,
    input: z.object({}),
    output: z.object({ summary: financeSummarySchema })
};
const accountDraftSchema = z.object({
    name: z.string().min(1).max(FINANCE_NAME_MAX_LENGTH),
    kind: financeAccountKindSchema,
    color: financeColorSchema,
    initialBalance: financeBalanceSchema,
    /** Aujourd'hui quand il est omis à la création : le solde saisi est celui du jour. */
    openedOn: financeDateSchema.optional(),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    archived: z.boolean()
});
/** `archived` inclut les comptes mis de côté ; sans lui, seuls les vivants, ce que veulent les sélecteurs. */
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
/** Refusé (`conflict`) tant qu'il porte des opérations : le geste réversible est l'archivage. */
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
/** Les opérations retombent dans « Sans catégorie » (`ON DELETE SET NULL`). */
export const financeCategoryRemove = {
    command: 'finance.categoryRemove' as const,
    input: z.object({ categoryId }),
    output: z.object({ categoryId })
};
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
 * Le journal, filtré en SQL sur les colonnes en clair. Pas de recherche
 * textuelle : intitulé et tiers sont chiffrés, le client filtre ce qu'il a
 * chargé. `totals` porte les sommes de tout le filtre, pas de la page.
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
 * Commande à part : pointer se répète des dizaines de fois au rapprochement,
 * et passer par `transactionUpdate` rechiffrerait le contenu à chaque clic.
 */
export const financeTransactionSetCleared = {
    command: 'finance.transactionSetCleared' as const,
    input: z.object({
        transactionIds: z.array(transactionId).min(1).max(500),
        cleared: z.boolean()
    }),
    output: z.object({ transactionIds: z.array(transactionId), cleared: z.boolean() })
};
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
/** Écrit l'occurrence attendue et avance la date. `amount` corrige au passage une facture qui varie. */
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
export const financeOverview = {
    command: 'finance.overview' as const,
    input: z.object({ range: financeRangeSchema }),
    output: z.object({ overview: financeOverviewSchema })
};
export const financeCommands = [
    financeConfig,
    financeInvoicingLink,
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
    financeTransactionList,
    financeTransactionAdd,
    financeTransactionUpdate,
    financeTransactionRemove,
    financeTransactionSetCleared,
    financeRecurringList,
    financeRecurringAdd,
    financeRecurringUpdate,
    financeRecurringRemove,
    financeRecurringPost,
    financeRecurringSkip,
    financeOverview
] as const;
