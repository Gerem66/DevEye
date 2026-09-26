import { z } from 'zod';

import { financeAmountSchema, financeBalanceSchema, financeDateSchema } from './domain';

/**
 * Une ligne de relevé bancaire, telle que le navigateur la lit dans un fichier
 * et l'envoie : le format de la banque est derrière. Le montant reste positif,
 * le sens dit s'il entre ou s'il sort.
 */

export const STATEMENT_LABEL_MAX_LENGTH = 300;

/** Combien de lignes un envoi porte au plus : un relevé d'un an tient dedans. */
export const STATEMENT_LINES_MAX = 2_000;

export const statementDirectionSchema = z.enum(['in', 'out']);
export type StatementDirection = z.infer<typeof statementDirectionSchema>;

export const statementLineInputSchema = z.object({
    date: financeDateSchema,
    direction: statementDirectionSchema,
    amount: financeAmountSchema.refine((value) => value > 0, 'Un montant nul n’est pas un mouvement.'),
    label: z.string().max(STATEMENT_LABEL_MAX_LENGTH),
    memo: z.string().max(STATEMENT_LABEL_MAX_LENGTH),
    /** L'identifiant que la banque donne à la ligne (`FITID` d'un OFX), `null` pour un CSV. */
    fitid: z.string().min(1).max(80).nullable()
});
export type StatementLineInput = z.infer<typeof statementLineInputSchema>;

/** Le solde que la banque annonce à une date, quand le fichier le porte. */
export const statementClosingSchema = z.object({ balance: financeBalanceSchema, date: financeDateSchema });
export type StatementClosing = z.infer<typeof statementClosingSchema>;

/**
 * Un libellé tel qu'une règle le compare et qu'une empreinte le retient : sans
 * accents, en minuscules, les espaces ramenés à un. « Prlv SEPA  OVH » et
 * « PRLV SEPA OVH » sont la même ligne, et « Été » se cherche en « ete ».
 */
export function normalizeLabel(value: string): string {
    return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** La correspondance des colonnes d'un CSV, retenue par compte : le même export se relit sans rien redemander. */
export const csvMappingSchema = z.object({
    /** L'en-tête qu'elle décrit : un autre export se redevine. */
    signature: z.string().max(2_000),
    date: z.number().int().nonnegative(),
    label: z.array(z.number().int().nonnegative()).max(8),
    amount: z.number().int().nonnegative().nullable(),
    debit: z.number().int().nonnegative().nullable(),
    credit: z.number().int().nonnegative().nullable(),
    balance: z.number().int().nonnegative().nullable(),
    dayFirst: z.boolean()
});
export type CsvMappingStored = z.infer<typeof csvMappingSchema>;

/** Ce qu'une ligne en attente pourrait être : le rapprochement propose, la personne choisit. */
export const statementProposalSchema = z.discriminatedUnion('kind', [
    /** Une opération du livre au même montant, parmi plusieurs : laquelle ? */
    z.object({
        kind: z.literal('transaction'),
        transactionId: z.number().int().positive(),
        label: z.string(),
        date: financeDateSchema
    }),
    /** Une échéance manuelle due, au même montant : l'enregistrer par cette ligne. */
    z.object({
        kind: z.literal('recurring'),
        recurringId: z.number().int().positive(),
        label: z.string(),
        date: financeDateSchema
    }),
    /** Une facture qui attend exactement ce montant : le règlement s'enregistre dans Facturation. */
    z.object({
        kind: z.literal('invoice'),
        docId: z.number().int().positive(),
        docNumber: z.string(),
        clientName: z.string(),
        segment: z.string()
    })
]);
export type StatementProposal = z.infer<typeof statementProposalSchema>;

export const statementLineSchema = z.object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive(),
    date: financeDateSchema,
    direction: statementDirectionSchema,
    amount: financeAmountSchema,
    label: z.string(),
    memo: z.string(),
    /** `pending` : à rapprocher. `matched` : elle confirme `transactionId`. `ignored` : écartée à la main. */
    status: z.enum(['pending', 'matched', 'ignored']),
    transactionId: z.number().int().positive().nullable(),
    proposals: z.array(statementProposalSchema)
});
export type StatementLine = z.infer<typeof statementLineSchema>;

/** Une règle : une ligne dont le libellé contient ce texte va dans cette catégorie, sans rien demander. */
export const financeRuleSchema = z.object({
    id: z.number().int().positive(),
    contains: z.string().min(1).max(80),
    /** `null` : les deux sens, la catégorie tranche. */
    direction: statementDirectionSchema.nullable(),
    categoryId: z.number().int().positive(),
    /** La TVA d'une dépense qu'elle range, en points de base. */
    vatRateBp: z.number().int().min(0).max(10_000).nullable(),
    /** Combien de lignes elle a rangées. */
    hits: z.number().int().nonnegative()
});
export type FinanceRule = z.infer<typeof financeRuleSchema>;

/** Ce qu'un import a donné : le compte rendu que l'écran montre au bout. */
export const statementImportResultSchema = z.object({
    received: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    /** Des lignes déjà là, d'un import précédent : rien n'est compté deux fois. */
    duplicates: z.number().int().nonnegative(),
    /** Rapprochées d'une opération déjà au livre. */
    matched: z.number().int().nonnegative(),
    /** Rangées par une règle. */
    ruled: z.number().int().nonnegative(),
    /** Ce qui reste à rapprocher sur le compte, cet import et les précédents. */
    pending: z.number().int().nonnegative(),
    /**
     * Sur un compte encore vide, le solde de départ que le relevé implique : ce
     * que la banque annonce, moins les lignes. `null` sinon.
     */
    opening: statementClosingSchema.nullable()
});
export type StatementImportResult = z.infer<typeof statementImportResultSchema>;

/* Lignes SQL (serveur uniquement). */

export interface FinanceStatementLineRow {
    id: number;
    workspace_id: number;
    account_id: number;
    import_id: number | null;
    external_id: string;
    /** `AAAA-MM-JJ`, projeté par `DATE_FORMAT`. */
    date: string;
    direction: StatementDirection;
    amount: number;
    transaction_id: number | null;
    ignored: number;
    /** `{ label, memo }` chiffré, étage ouvert. */
    content: string;
}

export interface FinanceRuleRow {
    id: number;
    workspace_id: number;
    direction: StatementDirection | null;
    category_id: number;
    vat_rate_bp: number | null;
    sort_order: number;
    hits: number;
    /** `{ contains }` chiffré, étage ouvert. */
    content: string;
}
