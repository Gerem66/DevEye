import { z } from 'zod';

/**
 * Le grand livre d'un espace. Les montants sont des entiers de centimes,
 * jamais un flottant : l'écart s'accumulerait à chaque écriture. Les dates
 * sont des jours civils (`AAAA-MM-JJ`), pas des instants : un epoch
 * déplacerait une dépense d'un jour selon le fuseau. Nombres, dates et
 * rattachements restent en clair (on agrège dessus en SQL), le texte libre
 * est chiffré.
 */

/** Plafond d'un montant, en centimes: mille milliards d'unités. */
export const FINANCE_AMOUNT_MAX = 100_000_000_000_000;

export const FINANCE_LABEL_MAX_LENGTH = 160;
export const FINANCE_NAME_MAX_LENGTH = 80;
export const FINANCE_NOTE_MAX_LENGTH = 2_000;
export const FINANCE_COUNTERPARTY_MAX_LENGTH = 120;

/** Toujours positif : le sens est porté par le `kind`, pas par le signe. */
export const financeAmountSchema = z.number().int().nonnegative().max(FINANCE_AMOUNT_MAX);

/** Un solde, lui, est signé: un compte peut être à découvert. */
export const financeBalanceSchema = z.number().int().min(-FINANCE_AMOUNT_MAX).max(FINANCE_AMOUNT_MAX);

/** Un jour civil, `AAAA-MM-JJ`. */
export const financeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

/** Un mois civil, `AAAA-MM`, tel que le rendent les séries du tableau de bord. */
export const financeMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);

/** Palette nommée, adossée aux jetons `--finance-<nom>` : la valeur stockée suit le thème. */
export const financeColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink']);
export type FinanceColor = z.infer<typeof financeColorSchema>;

export const FINANCE_COLORS = financeColorSchema.options;

/** Code ISO 4217. Une seule devise par espace : le multidevise serait un taux de change daté par opération. */
export const financeCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** `vatEnabled` est le seul commutateur entre usage particulier et PME : il fait apparaître la TVA. */
export const financeConfigSchema = z.object({
    currency: financeCurrencySchema,
    vatEnabled: z.boolean()
});
export type FinanceConfig = z.infer<typeof financeConfigSchema>;

/** Sert à l'icône, et à compter l'épargne à part du disponible sur le tableau de bord. */
export const financeAccountKindSchema = z.enum(['checking', 'savings', 'cash', 'card', 'business', 'other']);
export type FinanceAccountKind = z.infer<typeof financeAccountKindSchema>;

/**
 * `balance` : aujourd'hui compris. `projected` : avec les opérations déjà
 * datées plus tard. `cleared` : seulement le pointé, le seul comparable au
 * relevé de la banque.
 */
export const financeAccountSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(FINANCE_NAME_MAX_LENGTH),
    kind: financeAccountKindSchema,
    color: financeColorSchema,
    /** Solde de départ, avant toute opération enregistrée dans DevEye. */
    initialBalance: financeBalanceSchema,
    balance: financeBalanceSchema,
    projected: financeBalanceSchema,
    cleared: financeBalanceSchema,
    /** Nombre d'opérations rattachées, toutes dates confondues. */
    transactionCount: z.number().int().nonnegative(),
    /** Un compte archivé sort des totaux et des sélecteurs, sans rien perdre. */
    archived: z.boolean(),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    sortOrder: z.number().int().nonnegative(),
    created: z.number().int().nonnegative()
});
export type FinanceAccount = z.infer<typeof financeAccountSchema>;

/** Une catégorie ne sert qu'un sens. */
export const financeFlowSchema = z.enum(['expense', 'income']);
export type FinanceFlow = z.infer<typeof financeFlowSchema>;

export const financeCategorySchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(FINANCE_NAME_MAX_LENGTH),
    flow: financeFlowSchema,
    color: financeColorSchema,
    /** Classe d'icône (`icons.css`), sans le préfixe `icon-`. */
    icon: z.string().max(40),
    sortOrder: z.number().int().nonnegative()
});
export type FinanceCategory = z.infer<typeof financeCategorySchema>;

/**
 * Un virement est une seule ligne portant ses deux comptes : une paire à
 * moitié supprimée ferait apparaître de l'argent.
 */
export const financeTransactionKindSchema = z.enum(['expense', 'income', 'transfer']);
export type FinanceTransactionKind = z.infer<typeof financeTransactionKindSchema>;

export const financeTransactionSchema = z.object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive(),
    kind: financeTransactionKindSchema,
    amount: financeAmountSchema,
    date: financeDateSchema,
    label: z.string().max(FINANCE_LABEL_MAX_LENGTH),
    categoryId: z.number().int().positive().nullable(),
    /** Le compte crédité, pour un virement seulement. */
    transferAccountId: z.number().int().positive().nullable(),
    /** Qui a été payé, ou qui a payé. Texte libre, chiffré. */
    counterparty: z.string().max(FINANCE_COUNTERPARTY_MAX_LENGTH),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    /** Part de TVA en centimes, ou `null`. Le taux n'est pas stocké : un couple taux / montant pourrait être incohérent. */
    vatAmount: financeAmountSchema.nullable(),
    /** Vue sur le relevé de la banque. C'est ce que compte `cleared`. */
    cleared: z.boolean(),
    /** L'échéance qui l'a engendrée, quand elle vient d'une échéance. */
    recurringId: z.number().int().positive().nullable(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative()
});
export type FinanceTransaction = z.infer<typeof financeTransactionSchema>;

/** Périodicité d'un budget. */
export const financeBudgetPeriodSchema = z.enum(['monthly', 'quarterly', 'yearly']);
export type FinanceBudgetPeriod = z.infer<typeof financeBudgetPeriodSchema>;

/** `spent` et `remaining` sont calculés à la lecture, jamais stockés : un budget est une règle, pas un compteur. */
export const financeBudgetSchema = z.object({
    id: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    amount: financeAmountSchema,
    period: financeBudgetPeriodSchema,
    /** Consommé sur la période en cours. */
    spent: financeAmountSchema,
    /** Ce qu'il reste. Négatif quand l'enveloppe est dépassée. */
    remaining: financeBalanceSchema,
    /** Premier jour de la période en cours, pour situer le calcul. */
    periodStart: financeDateSchema,
    /** Premier jour de la période suivante (borne exclue). */
    periodEnd: financeDateSchema
});
export type FinanceBudget = z.infer<typeof financeBudgetSchema>;

/** Cadence d'une échéance. Combinée à `interval`: « tous les 2 mois ». */
export const financeFrequencySchema = z.enum(['weekly', 'monthly', 'quarterly', 'yearly']);
export type FinanceFrequency = z.infer<typeof financeFrequencySchema>;

/**
 * Une opération qui revient. `automatic` : écrite d'elle-même à la première
 * lecture qui suit la date ; sinon proposée, et attend un clic (montant
 * variable). Voir `postDueRecurring` : matérialisation paresseuse, pas de
 * tâche de fond.
 */
export const financeRecurringSchema = z.object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive(),
    kind: financeTransactionKindSchema,
    amount: financeAmountSchema,
    label: z.string().max(FINANCE_LABEL_MAX_LENGTH),
    categoryId: z.number().int().positive().nullable(),
    transferAccountId: z.number().int().positive().nullable(),
    counterparty: z.string().max(FINANCE_COUNTERPARTY_MAX_LENGTH),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    vatAmount: financeAmountSchema.nullable(),
    frequency: financeFrequencySchema,
    /** « Tous les N » de la cadence. 1 = à chaque fois. */
    interval: z.number().int().positive().max(60),
    /** Prochaine occurrence attendue. */
    nextDate: financeDateSchema,
    /** Dernier jour couvert, ou `null` pour sans fin. */
    endDate: financeDateSchema.nullable(),
    automatic: z.boolean(),
    /** Suspendue: plus rien n'est écrit ni proposé, sans rien perdre. */
    active: z.boolean(),
    /** Date de la dernière occurrence effectivement écrite. */
    lastPostedDate: financeDateSchema.nullable(),
    created: z.number().int().nonnegative()
});
export type FinanceRecurring = z.infer<typeof financeRecurringSchema>;

/** Fenêtre d'analyse du tableau de bord. */
export const financeRangeSchema = z.enum(['month', 'quarter', 'year']);
export type FinanceRange = z.infer<typeof financeRangeSchema>;

/** Un mois de la frise entrées / sorties. */
export const financeMonthPointSchema = z.object({
    month: financeMonthSchema,
    income: financeAmountSchema,
    expense: financeAmountSchema,
    /** Solde cumulé de tous les comptes actifs à la fin de ce mois. */
    balance: financeBalanceSchema
});
export type FinanceMonthPoint = z.infer<typeof financeMonthPointSchema>;

/** Une part de la répartition par catégorie sur la fenêtre. */
export const financeCategoryShareSchema = z.object({
    /** `null` = les opérations sans catégorie, rassemblées. */
    categoryId: z.number().int().positive().nullable(),
    flow: financeFlowSchema,
    amount: financeAmountSchema,
    count: z.number().int().nonnegative()
});
export type FinanceCategoryShare = z.infer<typeof financeCategoryShareSchema>;

/** Une occurrence attendue, telle que l'annonce le tableau de bord. */
export const financeUpcomingSchema = z.object({
    recurringId: z.number().int().positive(),
    date: financeDateSchema,
    label: z.string(),
    kind: financeTransactionKindSchema,
    amount: financeAmountSchema,
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable(),
    automatic: z.boolean(),
    /** L'échéance est en retard: sa date est déjà passée. */
    overdue: z.boolean()
});
export type FinanceUpcoming = z.infer<typeof financeUpcomingSchema>;

/** Tout le tableau de bord en une réponse : ces chiffres doivent être cohérents entre eux. */
export const financeOverviewSchema = z.object({
    currency: financeCurrencySchema,
    /** Bornes de la fenêtre analysée (`to` exclu). */
    from: financeDateSchema,
    to: financeDateSchema,
    /** Somme des soldes du jour, comptes archivés exclus. */
    netBalance: financeBalanceSchema,
    /** La part de `netBalance` posée sur des comptes d'épargne. */
    savings: financeBalanceSchema,
    /** `netBalance` en tenant compte des opérations déjà datées plus tard. */
    projected: financeBalanceSchema,
    income: financeAmountSchema,
    expense: financeAmountSchema,
    /** Entrées moins sorties sur la fenêtre. Négatif quand on a puisé. */
    net: financeBalanceSchema,
    /** Même fenêtre, décalée d'une période en arrière, pour la comparaison. */
    previousIncome: financeAmountSchema,
    previousExpense: financeAmountSchema,
    months: z.array(financeMonthPointSchema),
    categories: z.array(financeCategoryShareSchema),
    budgets: z.array(financeBudgetSchema),
    upcoming: z.array(financeUpcomingSchema),
    /** Récapitulatif TVA sur la fenêtre, ou `null` hors mode entreprise. */
    vat: z
        .object({
            collected: financeAmountSchema,
            deductible: financeAmountSchema,
            /** Collectée moins déductible: ce qui est dû (positif) ou à récupérer. */
            due: financeBalanceSchema
        })
        .nullable()
});
export type FinanceOverview = z.infer<typeof financeOverviewSchema>;

/** Ce que lit la carte de l'accueil. Volontairement minuscule. */
export const financeSummarySchema = z.object({
    currency: financeCurrencySchema,
    balance: financeBalanceSchema,
    /** Entrées et sorties du mois civil en cours. */
    income: financeAmountSchema,
    expense: financeAmountSchema,
    accountCount: z.number().int().nonnegative()
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

/* Lignes SQL (serveur uniquement). */

export interface FinanceConfigRow {
    workspace_id: number;
    currency: string;
    vat_enabled: number;
}

export interface FinanceAccountRow {
    id: number;
    workspace_id: number;
    kind: FinanceAccountKind;
    color: FinanceColor;
    initial_balance: number;
    archived: number;
    sort_order: number;
    /** `{ name, note }` chiffré, étage ouvert. */
    content: string;
    created: number;
}

/** Une ligne de compte accompagnée de ses soldes calculés par la requête. */
export interface FinanceAccountBalanceRow extends FinanceAccountRow {
    balance: number;
    projected: number;
    cleared: number;
    transaction_count: number;
}

export interface FinanceCategoryRow {
    id: number;
    workspace_id: number;
    flow: FinanceFlow;
    color: FinanceColor;
    icon: string;
    sort_order: number;
    /** `{ name }` chiffré, étage ouvert. */
    content: string;
    created: number;
}

export interface FinanceTransactionRow {
    id: number;
    workspace_id: number;
    account_id: number;
    transfer_account_id: number | null;
    category_id: number | null;
    recurring_id: number | null;
    kind: FinanceTransactionKind;
    amount: number;
    vat_amount: number | null;
    /** `AAAA-MM-JJ`. La colonne est un `DATE` que le pilote rendrait en `Date` : le dépôt la projette par `DATE_FORMAT`. */
    date: string;
    cleared: number;
    /** `{ label, counterparty, note }` chiffré, étage ouvert. */
    content: string;
    created: number;
    updated: number;
}

export interface FinanceBudgetRow {
    id: number;
    workspace_id: number;
    category_id: number;
    amount: number;
    period: FinanceBudgetPeriod;
    created: number;
}

export interface FinanceRecurringRow {
    id: number;
    workspace_id: number;
    account_id: number;
    transfer_account_id: number | null;
    category_id: number | null;
    kind: FinanceTransactionKind;
    amount: number;
    vat_amount: number | null;
    frequency: FinanceFrequency;
    interval_count: number;
    next_date: string;
    /**
     * Jour du mois de la série, `null` en hebdomadaire. Dérivé de `next_date` à
     * l'écriture : empêche une échéance au 31 de dériver au 28 après un février.
     */
    anchor_day: number | null;
    end_date: string | null;
    last_posted_date: string | null;
    automatic: number;
    active: number;
    /** `{ label, counterparty, note }` chiffré, étage ouvert. */
    content: string;
    created: number;
}
