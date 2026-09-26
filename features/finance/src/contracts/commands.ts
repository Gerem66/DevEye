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
    financeCategoryRoleSchema,
    financeRecurringSchema,
    financeStatusSettingsSchema,
    financeSummarySchema,
    financeTransactionKindSchema,
    financeTransactionSchema
} from './domain';
import {
    csvMappingSchema,
    financeRuleSchema,
    STATEMENT_LINES_MAX,
    statementClosingSchema,
    statementImportResultSchema,
    statementLineInputSchema,
    statementLineSchema
} from './statement';
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
/**
 * Le statut de l'activité. Choisir « micro » demande une activité et une
 * cadence ; le jour de suivi part du début du mois quand personne ne l'a dit.
 */
export const financeStatusSet = {
    command: 'finance.statusSet' as const,
    input: z.object({ status: financeStatusSettingsSchema }),
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
    icon: z.string().max(40),
    /** Absent : `null`, du chiffre d'affaires ou une charge. */
    role: financeCategoryRoleSchema.nullable().default(null)
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
/**
 * Un relevé lu dans le navigateur. Le serveur ne garde que les lignes qu'il
 * n'a pas déjà (par leur identité chez la banque), les rapproche, et retient la
 * correspondance des colonnes d'un CSV pour le prochain.
 */
export const financeStatementImport = {
    command: 'finance.statementImport' as const,
    input: z.object({
        accountId,
        format: z.enum(['csv', 'ofx']),
        lines: z.array(statementLineInputSchema).min(1).max(STATEMENT_LINES_MAX),
        closing: statementClosingSchema.nullable(),
        mapping: csvMappingSchema.nullable()
    }),
    output: z.object({ result: statementImportResultSchema })
};
/** La correspondance des colonnes retenue au dernier import CSV de ce compte. */
export const financeImportMapping = {
    command: 'finance.importMapping' as const,
    input: z.object({ accountId }),
    output: z.object({ mapping: csvMappingSchema.nullable() })
};
/**
 * Les lignes de relevé, celles à rapprocher d'abord, avec ce qu'elles
 * pourraient être. `banks` : pour chaque compte, le dernier solde que la banque
 * a annoncé, face au solde pointé du livre à la même date.
 */
export const financeStatementList = {
    command: 'finance.statementList' as const,
    input: z.object({
        status: z.enum(['pending', 'all']),
        accountId: accountId.optional(),
        limit: z.number().int().positive().max(500).optional()
    }),
    output: z.object({
        lines: z.array(statementLineSchema),
        pendingCount: z.number().int().nonnegative(),
        banks: z.array(
            z.object({ accountId, date: financeDateSchema, bank: financeBalanceSchema, book: financeBalanceSchema })
        )
    })
};
const statementActionSchema = z.discriminatedUnion('kind', [
    /** Elle confirme cette opération du livre. */
    z.object({ kind: z.literal('link'), transactionId }),
    /**
     * Elle entre au livre. `label` à `null` : le libellé de la banque. `rule` :
     * retenir que ce texte range dans cette catégorie, pour les suivantes.
     */
    z.object({
        kind: z.literal('create'),
        categoryId: categoryId.nullable(),
        label: z.string().max(FINANCE_LABEL_MAX_LENGTH).nullable(),
        counterparty: z.string().max(FINANCE_COUNTERPARTY_MAX_LENGTH),
        vatRateBp: z.number().int().min(0).max(10_000).nullable(),
        rule: z.object({ contains: z.string().trim().min(2).max(80) }).nullable()
    }),
    /** Un virement vers un autre compte du livre, ou depuis lui. */
    z.object({ kind: z.literal('transfer'), accountId }),
    /** L'occurrence d'une échéance manuelle, à ce montant. */
    z.object({ kind: z.literal('post'), recurringId }),
    z.object({ kind: z.literal('ignore') }),
    z.object({ kind: z.literal('restore') })
]);
/**
 * Plusieurs lignes à la fois pour créer, ignorer ou rétablir ; une seule pour le
 * reste. Un rapprochement se défait par l'opération : la modifier, ou la
 * supprimer, ce qui écarte la ligne qui la confirmait.
 */
export const financeStatementResolve = {
    command: 'finance.statementResolve' as const,
    input: z.object({
        lineIds: z.array(z.number().int().positive()).min(1).max(500),
        action: statementActionSchema
    }),
    output: z.object({ resolved: z.number().int().nonnegative(), pending: z.number().int().nonnegative() })
};
const ruleDraftSchema = financeRuleSchema.omit({ id: true, hits: true });
export const financeRuleList = {
    command: 'finance.ruleList' as const,
    input: z.object({}),
    output: z.object({ rules: z.array(financeRuleSchema) })
};
/** `id` à `null` : une règle neuve. Elle range aussitôt les lignes en attente qu'elle reconnaît. */
export const financeRuleSave = {
    command: 'finance.ruleSave' as const,
    input: z.object({ id: z.number().int().positive().nullable(), rule: ruleDraftSchema }),
    output: z.object({ rule: financeRuleSchema })
};
export const financeRuleRemove = {
    command: 'finance.ruleRemove' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ id: z.number().int().positive() })
};
export const financeOverview = {
    command: 'finance.overview' as const,
    input: z.object({ range: financeRangeSchema }),
    output: z.object({ overview: financeOverviewSchema })
};
export const financeCommands = [
    financeConfig,
    financeInvoicingLink,
    financeStatusSet,
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
    financeStatementImport,
    financeImportMapping,
    financeStatementList,
    financeStatementResolve,
    financeRuleList,
    financeRuleSave,
    financeRuleRemove,
    financeOverview
] as const;
