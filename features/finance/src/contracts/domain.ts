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

/** Palette nommée, adossée aux jetons `--palette-<nom>` : la valeur stockée suit le thème. */
export const financeColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink']);
export type FinanceColor = z.infer<typeof financeColorSchema>;

export const FINANCE_COLORS = financeColorSchema.options;

/** Code ISO 4217. Une seule devise par espace : le multidevise serait un taux de change daté par opération. */
export const financeCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Micro-entreprise, ou entreprise (société, entreprise individuelle au réel) qui garde une part de son bénéfice. */
export const financeLegalStatusSchema = z.enum(['micro', 'company']);
export type FinanceLegalStatus = z.infer<typeof financeLegalStatusSchema>;

export const financeMicroActivitySchema = z.enum(['bnc', 'bnc_cipav', 'bic_services', 'bic_sales']);

export const financeDeclarationPeriodSchema = z.enum(['monthly', 'quarterly']);

/** Un taux en points de base : 1 % = 100. */
export const financeRateBpSchema = z.number().int().min(0).max(10_000);

/**
 * Le statut de l'activité, qui dit ce qu'il faut mettre de côté. `null` tant
 * que personne ne l'a dit : l'accueil ne calcule alors rien.
 */
export const financeStatusSettingsSchema = z.object({
    legalStatus: financeLegalStatusSchema.nullable(),
    /** Micro : l'activité déclarée, qui fixe les taux et les seuils. */
    microActivity: financeMicroActivitySchema.nullable(),
    /**
     * Micro : un taux de cotisations choisi à la place du taux légal (l'ACRE),
     * `null` pour le taux légal. Entreprise : la part du bénéfice à garder.
     */
    provisionRateBp: financeRateBpSchema.nullable(),
    /** Micro : l'impôt sur le revenu payé avec les cotisations. */
    incomeTaxPrepaid: z.boolean(),
    /** Micro : la cadence des déclarations à l'URSSAF. */
    declarationPeriod: financeDeclarationPeriodSchema.nullable(),
    /**
     * Depuis quand la TVA due et la part du bénéfice s'additionnent, moins ce
     * qui a été versé depuis dans les catégories qui le paient.
     */
    trackingSince: financeDateSchema.nullable()
});
export type FinanceStatusSettings = z.infer<typeof financeStatusSettingsSchema>;

/**
 * La devise et la TVA viennent de Facturation, qui en a besoin pour émettre :
 * une seule vérité. `vatEnabled` fait apparaître la TVA sur les saisies et son
 * récapitulatif à l'accueil. `invoicing` dit où arrivent les règlements.
 */
export const financeConfigSchema = z.object({
    currency: financeCurrencySchema,
    vatEnabled: z.boolean(),
    invoicing: z.object({
        /** Facturation est installée : ses règlements peuvent arriver ici. */
        available: z.boolean(),
        /** Le compte qui reçoit les règlements, `null` tant qu'aucun ne les reçoit. */
        accountId: z.number().int().positive().nullable(),
        /** La catégorie de recettes où ils se rangent. */
        categoryId: z.number().int().positive().nullable()
    }),
    status: financeStatusSettingsSchema
});
export type FinanceConfig = z.infer<typeof financeConfigSchema>;

/** Sert à l'icône, et à compter l'épargne (là où l'on range ses provisions) à part du disponible. */
export const financeAccountKindSchema = z.enum(['checking', 'savings', 'cash', 'other']);
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
    /**
     * Le jour où ce solde de départ a été relevé. Rien d'antérieur ne se recopie
     * de Facturation sur ce compte : le solde de départ le compte déjà.
     */
    openedOn: financeDateSchema,
    balance: financeBalanceSchema,
    projected: financeBalanceSchema,
    cleared: financeBalanceSchema,
    /** Nombre d'opérations rattachées, toutes dates confondues. */
    transactionCount: z.number().int().nonnegative(),
    /** Un compte archivé sort des sélecteurs de saisie mais reste dans les totaux : l'argent ne disparaît pas. */
    archived: z.boolean(),
    note: z.string().max(FINANCE_NOTE_MAX_LENGTH),
    sortOrder: z.number().int().nonnegative(),
    created: z.number().int().nonnegative()
});
export type FinanceAccount = z.infer<typeof financeAccountSchema>;

/** Une catégorie ne sert qu'un sens. */
export const financeFlowSchema = z.enum(['expense', 'income']);
export type FinanceFlow = z.infer<typeof financeFlowSchema>;

/**
 * Ce qu'une catégorie compte, au-delà de son sens. Recette : `null` pour du
 * chiffre d'affaires, `other` pour ce qui n'en est pas (un remboursement).
 * Dépense : `null` pour une charge, ou ce qu'elle verse (cotisations, impôts,
 * TVA), qui se déduit de ce qu'il reste à mettre de côté.
 */
export const financeCategoryRoleSchema = z.enum(['other', 'social', 'tax', 'vat']);
export type FinanceCategoryRole = z.infer<typeof financeCategoryRoleSchema>;

export const financeCategorySchema = z.object({
    id: z.number().int().positive(),
    name: z.string().max(FINANCE_NAME_MAX_LENGTH),
    flow: financeFlowSchema,
    color: financeColorSchema,
    /** Classe d'icône (`icons.css`), sans le préfixe `icon-`. */
    icon: z.string().max(40),
    role: financeCategoryRoleSchema.nullable(),
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
    /**
     * Le règlement de Facturation dont elle est la copie, ou `null`. Ses faits
     * (montant, date, TVA, intitulé) se corrigent là-bas, jamais ici.
     */
    origin: z
        .object({
            docNumber: z.string(),
            /** Ce que `openFeature('invoicing', segment)` ouvre : la facture. */
            segment: z.string()
        })
        .nullable(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative()
});
export type FinanceTransaction = z.infer<typeof financeTransactionSchema>;

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
    /** Solde cumulé de tous les comptes, archivés compris, à la fin de ce mois. */
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

/** Une facture émise qui attend encore de l'argent, telle que Facturation la décrit. */
export const financeReceivableSchema = z.object({
    docNumber: z.string(),
    clientName: z.string(),
    dueOn: financeDateSchema.nullable(),
    remaining: financeAmountSchema,
    overdue: z.boolean(),
    segment: z.string()
});
export type FinanceReceivable = z.infer<typeof financeReceivableSchema>;

/** Un mois de la prévision : ce qui doit entrer, ce qui doit sortir, et le solde attendu à sa fin. */
export const financeForecastPointSchema = z.object({
    month: financeMonthSchema,
    incoming: financeAmountSchema,
    outgoing: financeAmountSchema,
    balance: financeBalanceSchema
});
export type FinanceForecastPoint = z.infer<typeof financeForecastPointSchema>;

/**
 * Ce que le statut fait dire à l'accueil. Des estimations, dites comme telles :
 * la déclaration fait foi.
 */
export const financeStatusSchema = z.object({
    legalStatus: financeLegalStatusSchema,
    /**
     * Micro : la déclaration à faire. La période close dont l'échéance n'est pas
     * passée, sinon celle en cours (`closed` à `false`, son chiffre encore partiel).
     */
    declaration: z
        .object({
            label: z.string(),
            from: financeDateSchema,
            to: financeDateSchema,
            deadline: financeDateSchema,
            closed: z.boolean(),
            /** Le chiffre d'affaires encaissé, hors TVA : ce qui se déclare. */
            revenue: financeAmountSchema,
            contributions: financeAmountSchema,
            incomeTax: financeAmountSchema
        })
        .nullable(),
    /** Ce qui est dû et pas encore versé : cotisations (ou part du bénéfice), impôt libératoire, TVA. */
    setAside: z.object({
        total: financeAmountSchema,
        contributions: financeAmountSchema,
        incomeTax: financeAmountSchema,
        vat: financeAmountSchema
    }),
    /** Le solde du jour, moins ce qu'il faut mettre de côté. */
    available: financeBalanceSchema,
    /** Micro : le chiffre d'affaires de l'année civile face aux seuils. */
    thresholds: z
        .object({
            year: z.number().int(),
            revenue: financeAmountSchema,
            /** Le même, plus ce que les factures en attente apporteront. */
            projected: financeAmountSchema,
            ceiling: financeAmountSchema,
            /** Les seuils de la franchise de TVA, `null` quand la TVA est déjà suivie. */
            vatBase: financeAmountSchema.nullable(),
            vatMajor: financeAmountSchema.nullable()
        })
        .nullable()
});
export type FinanceStatus = z.infer<typeof financeStatusSchema>;

/** Tout le tableau de bord en une réponse : ces chiffres doivent être cohérents entre eux. */
export const financeOverviewSchema = z.object({
    currency: financeCurrencySchema,
    /** Bornes de la fenêtre analysée (`to` exclu). */
    from: financeDateSchema,
    to: financeDateSchema,
    /** Somme des soldes du jour, comptes archivés compris. */
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
    upcoming: z.array(financeUpcomingSchema),
    /** Les dernières opérations datées au plus tard aujourd'hui, la plus récente en tête. */
    recent: z.array(financeTransactionSchema),
    /** Ce que les factures émises attendent encore, dans la devise du livre. `null` sans Facturation. */
    receivables: z
        .object({
            total: financeAmountSchema,
            overdue: financeAmountSchema,
            count: z.number().int().nonnegative(),
            overdueCount: z.number().int().nonnegative(),
            /** Les premières, la plus ancienne échéance d'abord. */
            items: z.array(financeReceivableSchema)
        })
        .nullable(),
    /**
     * Le mois en cours puis les deux suivants, à partir du solde du jour : les
     * factures à leur échéance (les retards comptés tout de suite), les
     * échéances récurrentes, et ce qui est déjà saisi à une date future.
     */
    forecast: z.array(financeForecastPointSchema),
    /** `null` tant que le statut n'est pas dit. */
    status: financeStatusSchema.nullable(),
    /** Les lignes de relevé qui attendent d'être rapprochées, tous comptes. */
    pendingLines: z.number().int().nonnegative(),
    /** Récapitulatif TVA sur la fenêtre, ou `null` quand la TVA n'est pas suivie. */
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
    accountCount: z.number().int().nonnegative(),
    /** Ce qu'il faut mettre de côté, `null` tant que le statut n'est pas dit. */
    setAside: financeAmountSchema.nullable()
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

/* Lignes SQL (serveur uniquement). */

export interface FinanceConfigRow {
    workspace_id: number;
    invoicing_account_id: number | null;
    invoicing_category_id: number | null;
    /** Ce qui décrivait la dernière recopie des règlements : tant qu'il ne bouge pas, rien à refaire. */
    invoicing_version: string | null;
    legal_status: FinanceLegalStatus | null;
    micro_activity: z.infer<typeof financeMicroActivitySchema> | null;
    provision_rate_bp: number | null;
    income_tax_prepaid: number;
    declaration_period: z.infer<typeof financeDeclarationPeriodSchema> | null;
    /** `AAAA-MM-JJ`, projeté par `DATE_FORMAT`. */
    tracking_since: string | null;
}

export interface FinanceAccountRow {
    id: number;
    workspace_id: number;
    kind: FinanceAccountKind;
    color: FinanceColor;
    initial_balance: number;
    /** `AAAA-MM-JJ`, projeté par `DATE_FORMAT`. */
    opened_on: string;
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
    role: FinanceCategoryRole | null;
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
    /** `'invoicing'` pour la copie d'un règlement, `null` pour une saisie. */
    source: string | null;
    /** L'identifiant du règlement recopié, unique par espace avec `source`. */
    source_ref: string | null;
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
