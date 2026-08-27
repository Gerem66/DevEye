import { z } from 'zod';

/**
 * Finances: le grand livre d'un espace, pour un particulier comme pour une PME.
 *
 * ## Les montants sont des entiers de centimes
 *
 * Jamais un flottant, nulle part: ni en base, ni sur le fil, ni dans le client.
 * `0.1 + 0.2 !== 0.3` est une curiosité amusante partout sauf sur un solde, où
 * l'écart s'accumule silencieusement à chaque écriture jusqu'à ce que la somme
 * des opérations ne retombe plus sur le solde affiché. Le formatage en devise
 * est la toute dernière étape, faite à l'affichage seul.
 *
 * ## Les dates sont des jours, pas des instants
 *
 * Une opération appartient à un jour civil (`AAAA-MM-JJ`), pas à un instant.
 * Un horodatage epoch se décalerait d'un fuseau à l'autre et ferait basculer une
 * dépense du 31 janvier au 1er février selon qui la regarde, ce qui déplacerait
 * un mois comptable entier. La colonne SQL est un `DATE`, et la chaîne voyage
 * telle quelle.
 *
 * ## Ce qui est chiffré, et ce qui ne peut pas l'être
 *
 * Le chiffrement de DevEye est non déterministe: rien de ce sur quoi on agrège
 * ne peut le traverser. Un solde, un budget et une répartition par catégorie
 * sont des `SUM(...) GROUP BY`, donc les **nombres, dates et rattachements**
 * restent en clair, et le **texte libre** (intitulé, tiers, note, nom de compte,
 * nom de catégorie) est chiffré. C'est le même partage que l'audience, et pour
 * la même raison: sans lui, calculer un solde imposerait de télécharger toutes
 * les opérations depuis le début dans le navigateur.
 */

/** Plafond d'un montant, en centimes: mille milliards d'unités. */
export const FINANCE_AMOUNT_MAX = 100_000_000_000_000;

export const FINANCE_LABEL_MAX_LENGTH = 160;
export const FINANCE_NAME_MAX_LENGTH = 80;
export const FINANCE_NOTE_MAX_LENGTH = 2_000;
export const FINANCE_COUNTERPARTY_MAX_LENGTH = 120;

/**
 * Un montant, en centimes, toujours **positif**. Le sens (entrée ou sortie) est
 * porté par le `kind` de l'opération et non par le signe: un montant signé
 * laisse exister « une dépense de -30 € », qui est une recette écrite de
 * travers, et oblige chaque écran à se demander ce qu'il regarde.
 */
export const financeAmountSchema = z.number().int().nonnegative().max(FINANCE_AMOUNT_MAX);

/** Un solde, lui, est signé: un compte peut être à découvert. */
export const financeBalanceSchema = z.number().int().min(-FINANCE_AMOUNT_MAX).max(FINANCE_AMOUNT_MAX);

/** Un jour civil, `AAAA-MM-JJ`. */
export const financeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

/** Un mois civil, `AAAA-MM`, tel que le rendent les séries du tableau de bord. */
export const financeMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * Palette nommée des comptes et des catégories, adossée aux jetons de thème
 * `--finance-<nom>`. Nommée plutôt que libre en hexadécimal: la valeur stockée
 * reste liée au thème, donc elle suit ses réglages au lieu de jurer avec eux le
 * jour où la palette est retouchée. Élargir cet enum ajoute une couleur.
 */
export const financeColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink']);
export type FinanceColor = z.infer<typeof financeColorSchema>;

export const FINANCE_COLORS = financeColorSchema.options;

/**
 * Devise de l'espace, code ISO 4217. Une seule par espace, et c'est délibéré:
 * le multidevise n'est pas un champ de plus mais un taux de change daté par
 * opération, sans quoi tout total additionnerait des euros et des dollars.
 */
export const financeCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/**
 * Réglages de la feature pour l'espace.
 *
 * `vatEnabled` est le seul commutateur entre l'usage particulier et l'usage
 * PME: il fait apparaître la TVA sur les opérations et le récapitulatif
 * collectée / déductible du tableau de bord. Rien d'autre ne change, parce que
 * rien d'autre n'a besoin de changer: un livre de comptes est le même objet des
 * deux côtés.
 */
export const financeConfigSchema = z.object({
    currency: financeCurrencySchema,
    vatEnabled: z.boolean()
});
export type FinanceConfig = z.infer<typeof financeConfigSchema>;

/**
 * Nature d'un compte. Sert à deux choses seulement: l'icône de la carte, et le
 * fait qu'une **épargne** soit comptée à part du disponible sur le tableau de
 * bord (avoir 8 000 € dont 7 000 bloqués sur un livret n'est pas la même
 * situation que 8 000 € sur un compte courant).
 */
export const financeAccountKindSchema = z.enum(['checking', 'savings', 'cash', 'card', 'business', 'other']);
export type FinanceAccountKind = z.infer<typeof financeAccountKindSchema>;

/**
 * Un compte, tel que le client le reçoit.
 *
 * Les trois soldes répondent à trois questions distinctes, et les confondre est
 * la source d'erreur la plus courante d'un livre de comptes:
 *  - `balance`: ce qu'il y a aujourd'hui, opérations datées d'aujourd'hui ou
 *    d'avant comprises. C'est le solde, sans autre qualificatif.
 *  - `projected`: le même en tenant compte des opérations déjà saisies à une
 *    date future (un loyer prélevé le 5, saisi le 2).
 *  - `cleared`: seulement ce qui a été **pointé**, c'est-à-dire vu sur le relevé
 *    de la banque. C'est celui-là que l'on compare au relevé, et lui seul.
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

/**
 * Sens d'une catégorie. Une catégorie ne sert qu'un sens: « Salaire » ne classe
 * pas une dépense, et proposer les deux dans un seul sélecteur transforme le
 * choix en fouille.
 */
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
 * Nature d'une opération.
 *
 * Un **virement** est une seule ligne et non deux: il porte son compte de
 * départ (`accountId`) et son compte d'arrivée (`transferAccountId`), et les
 * deux soldes en tiennent compte. Le représenter par une paire de lignes
 * obligerait à les garder cohérentes à chaque modification, et une paire à
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
    /**
     * Part de TVA du montant, en centimes, ou `null` quand la question ne se
     * pose pas. Le **taux** n'est pas stocké: il se déduit, et le stocker
     * ouvrirait la porte à un couple taux / montant incohérent, que rien ne
     * pourrait ensuite départager.
     */
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

/**
 * Une enveloppe posée sur une catégorie.
 *
 * `spent` et `remaining` sont calculés pour la période **en cours** au moment de
 * la lecture, jamais stockés: un budget est une règle, pas un compteur, et
 * mémoriser le compteur le ferait diverger dès qu'une opération passée est
 * corrigée.
 */
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
 * Une opération qui revient: loyer, salaire, abonnement, échéance de prêt.
 *
 * `automatic` décide de ce qui se passe quand la date arrive:
 *  - vrai: l'opération est écrite d'elle-même à la première lecture qui suit,
 *    parce qu'un salaire tombe qu'on regarde ou non;
 *  - faux: elle est proposée, et attend un clic. C'est ce qu'on veut d'une
 *    dépense dont le montant varie (électricité), qu'on ne veut pas voir
 *    apparaître à un montant faux.
 *
 * Voir `postDueRecurring` côté serveur pour le mécanisme, qui est une
 * matérialisation paresseuse et non une tâche de fond.
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

/**
 * Tout ce que montre le tableau de bord, en une réponse.
 *
 * Une seule commande et non six: ces chiffres se lisent ensemble et doivent
 * être cohérents entre eux. Six allers-retours indépendants laisseraient un
 * écran où le solde vient d'avant une écriture et la répartition d'après.
 */
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

/* ------------------------------------------------------------------ *
 * Lignes SQL (serveur uniquement)
 * ------------------------------------------------------------------ */

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
    /**
     * `AAAA-MM-JJ`. La colonne est un vrai `DATE`, dont le pilote rendrait un
     * objet `Date`: le dépôt la projette systématiquement par `DATE_FORMAT`,
     * pour qu'aucun fuseau ne s'interpose entre la base et l'écran.
     */
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
     * Jour du mois de la série (1 à 31), `null` pour une cadence hebdomadaire.
     * Dérivé de `next_date` à l'écriture, jamais fourni par le client: c'est ce
     * qui empêche une échéance au 31 de dériver au 28 après un février.
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
