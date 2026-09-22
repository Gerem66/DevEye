import { z } from 'zod';

/**
 * Les primitives du domaine. Trois règles portent tout le reste, héritées du
 * grand livre (`features/finance/README.md`) :
 *
 *  - un montant est un entier de **centimes**, jamais un flottant ni un
 *    décimal, et il est toujours **positif** : le sens vient du type de
 *    document, pas du signe ;
 *  - une date est un **jour civil** (`AAAA-MM-JJ`), pas un instant : une pièce
 *    appartient à un jour, et un horodatage la ferait changer de mois
 *    comptable selon le fuseau de qui la regarde ;
 *  - une quantité est un entier de **millièmes d'unité** : trois décimales
 *    représentent la demi-journée et le tiers d'heure, et aucune fraction
 *    décimale n'est exacte en binaire.
 */

/** Mille milliards de centimes : au-delà, c'est une faute de frappe. */
export const INVOICING_AMOUNT_MAX = 100_000_000_000_000;

/**
 * Le plafond d'un prix unitaire (un million) et celui d'une quantité (mille
 * unités). Leur produit vaut 10^14, donc reste exact en `number` : au-delà,
 * l'arithmétique entière cesserait d'en être une.
 */
export const INVOICING_UNIT_PRICE_MAX = 100_000_000;
export const INVOICING_QUANTITY_MILLI_MAX = 1_000_000;

export const amountSchema = z.number().int().nonnegative().max(INVOICING_AMOUNT_MAX);

export const unitPriceSchema = z.number().int().nonnegative().max(INVOICING_UNIT_PRICE_MAX);

export const quantityMilliSchema = z.number().int().nonnegative().max(INVOICING_QUANTITY_MILLI_MAX);

/** Un taux de TVA en points de base : `2000` vaut 20 %, `550` vaut 5,5 %. */
export const vatRateBpSchema = z.number().int().min(0).max(10_000);

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

/** ISO 4217. Une seule devise par espace : le multidevise exigerait un taux daté par pièce. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

/**
 * Les trois pièces. Un devis engage le client, une facture demande le paiement,
 * un avoir corrige une facture émise : c'est la seule correction possible, une
 * facture émise ne se modifiant ni ne se supprimant jamais.
 */
export const documentKindSchema = z.enum(['quote', 'invoice', 'credit']);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/**
 * Les statuts **stockés**, ceux qu'un humain pose. « En retard », « payée » et
 * « expiré » n'en font pas partie : ils changent sans que personne n'écrive
 * (voir `status.ts`), et les stocker demanderait une tâche de fond pour faire
 * passer minuit.
 */
export const documentStatusSchema = z.enum(['draft', 'sent', 'accepted', 'declined', 'issued', 'cancelled']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/** Une ligne `text` est un commentaire intercalaire : elle ne pèse sur aucun total. */
export const lineKindSchema = z.enum(['service', 'product', 'text']);
export type LineKind = z.infer<typeof lineKindSchema>;

/** Ce que la quantité compte. */
export const lineUnitSchema = z.enum(['hour', 'day', 'unit', 'month', 'fixed']);
export type LineUnit = z.infer<typeof lineUnitSchema>;

export const paymentMethodSchema = z.enum(['transfer', 'card', 'cash', 'check', 'other']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** `exempt` : franchise en base de TVA, article 293 B du CGI. */
export const vatRegimeSchema = z.enum(['standard', 'exempt']);
export type VatRegime = z.infer<typeof vatRegimeSchema>;

export const clientKindSchema = z.enum(['company', 'person']);
export type ClientKind = z.infer<typeof clientKindSchema>;

/**
 * L'onglet de réglages qu'un refus désigne. Il voyage dans les détails de
 * l'erreur plutôt que dans sa phrase : l'écran monte alors le bouton qui ouvre
 * cet onglet, et personne n'a à retrouver ce chemin au moment où il est bloqué.
 */
export const invoicingSettingsSectionSchema = z.enum(['general', 'taxes', 'numbering', 'wording']);
export type InvoicingSettingsSection = z.infer<typeof invoicingSettingsSectionSchema>;

export const invoicingErrorDetailsSchema = z.object({
    settingsSection: invoicingSettingsSectionSchema.optional(),
    /** Ou bien : la réponse est dans la fiche du client, que l'écran sait nommer. */
    clientFiche: z.literal(true).optional()
});

/**
 * Ce que la carte de l'accueil montre. Un montant plutôt qu'un décompte : le
 * nombre de documents ne dit rien, « ce qui reste à encaisser » dit tout.
 */
export const invoicingSummarySchema = z.object({
    currency: currencySchema,
    /** Le reste dû de toutes les factures émises et non soldées. */
    outstandingCents: amountSchema,
    /** Sa part échue. */
    overdueCents: amountSchema,
    overdueCount: z.number().int().nonnegative(),
    /** Les devis acceptés dont la facture n'est pas encore émise : de l'argent qui attend un geste. */
    toBillCents: amountSchema,
    toBillCount: z.number().int().nonnegative(),
    draftCount: z.number().int().nonnegative()
});

export type InvoicingSummary = z.infer<typeof invoicingSummarySchema>;

/**
 * L'identité de l'émetteur, telle qu'elle paraît en tête de chaque document.
 * Des champs séparés et non une adresse libre : le SIREN et le numéro de TVA
 * sont des mentions obligatoires distinctes, et un export en données
 * structurées les réclamera un jour tels quels.
 */
export const invoicingIssuerSchema = z.object({
    legalName: z.string().max(160).default(''),
    tradeName: z.string().max(160).default(''),
    legalForm: z.string().max(80).default(''),
    capital: z.string().max(80).default(''),
    address: z.string().max(240).default(''),
    postalCode: z.string().max(16).default(''),
    city: z.string().max(120).default(''),
    country: z.string().max(80).default(''),
    siret: z.string().max(32).default(''),
    vatNumber: z.string().max(32).default(''),
    rcs: z.string().max(120).default(''),
    email: z.string().max(160).default(''),
    phone: z.string().max(40).default(''),
    website: z.string().max(200).default(''),
    iban: z.string().max(40).default(''),
    bic: z.string().max(16).default(''),
    /** Obligatoire pour un artisan : l'assureur et la couverture géographique. */
    insurer: z.string().max(160).default(''),
    insuranceScope: z.string().max(200).default(''),
    /** Le logo en data URL carrée, produit par `fileToSquareDataUrl`. */
    logo: z.string().max(200_000).default('')
});

export type InvoicingIssuer = z.infer<typeof invoicingIssuerSchema>;

/**
 * Les phrases que chaque document porte. Toutes saisissables : une mention qui
 * change de loi doit rester une correction de formulaire, jamais une
 * modification de code.
 */
export const invoicingWordingSchema = z.object({
    paymentTerms: z.string().max(600).default(''),
    lateFeeText: z.string().max(600).default(''),
    /** Obligatoire entre professionnels, et son montant est fixé par la loi. */
    recoveryFeeText: z.string().max(600).default(''),
    discountText: z.string().max(600).default(''),
    /** « TVA non applicable, article 293 B du CGI », ou une autre exonération. */
    exemptionText: z.string().max(600).default(''),
    quoteTerms: z.string().max(600).default(''),
    signatureText: z.string().max(300).default(''),
    footer: z.string().max(600).default('')
});

export type InvoicingWording = z.infer<typeof invoicingWordingSchema>;

/** `never` : une seule séquence continue. `yearly` : elle repart à 1 chaque année. */
export const numberResetSchema = z.enum(['yearly', 'never']);
export type NumberReset = z.infer<typeof numberResetSchema>;

export const invoicingSettingsSchema = z.object({
    currency: currencySchema,
    /** Nom IANA du fuseau où « aujourd'hui » se décide. */
    timeZone: z.string().min(1).max(64),
    vatRegime: vatRegimeSchema,
    defaultVatBp: vatRateBpSchema,
    paymentTermsDays: z.number().int().min(0).max(365),
    quoteValidityDays: z.number().int().min(1).max(365),
    quotePrefix: z.string().max(8),
    invoicePrefix: z.string().max(8),
    creditPrefix: z.string().max(8),
    numberReset: numberResetSchema,
    numberStart: z.number().int().min(1).max(999_999),
    numberPad: z.number().int().min(1).max(8),
    mailSenderId: z.number().int().positive().nullable(),
    issuer: invoicingIssuerSchema,
    wording: invoicingWordingSchema
});

export type InvoicingSettings = z.infer<typeof invoicingSettingsSchema>;

/**
 * Ce que l'offre du propriétaire de l'espace permet ce mois-ci, par type de
 * pièce. Les devis et les factures se comptent séparément : proposer et
 * facturer ne sont pas le même geste, et une affaire consomme normalement un de
 * chaque. Les avoirs ne comptent nulle part, corriger une erreur n'est pas
 * facturer.
 *
 * Une entrée `null` : ce type-là n'est pas borné. L'usage entier `null` : aucun
 * module d'offre n'est installé, tout est illimité, et l'écran n'a rien à
 * annoncer. Une limite à `0` est valide et se lit « votre offre n'en inclut
 * aucun ».
 */
export const invoicingQuotaLineSchema = z.object({
    limit: z.number().int().nonnegative(),
    used: z.number().int().nonnegative()
});

export const invoicingQuotaUsageSchema = z.object({
    quotes: invoicingQuotaLineSchema.nullable(),
    invoices: invoicingQuotaLineSchema.nullable()
});

export type InvoicingQuotaLine = z.infer<typeof invoicingQuotaLineSchema>;
export type InvoicingQuotaUsage = z.infer<typeof invoicingQuotaUsageSchema>;

/**
 * Un client du carnet. Tout ce qui l'identifie est scellé ; seuls son type, ses
 * valeurs par défaut et sa mise de côté restent en clair, parce que le serveur
 * en a besoin pour lister et filtrer sans déchiffrer.
 */
export const invoicingClientInputSchema = z.object({
    kind: clientKindSchema,
    name: z.string().min(1).max(160),
    contactName: z.string().max(160).default(''),
    email: z.string().max(160).default(''),
    phone: z.string().max(40).default(''),
    address: z.string().max(240).default(''),
    postalCode: z.string().max(16).default(''),
    city: z.string().max(120).default(''),
    country: z.string().max(80).default(''),
    siret: z.string().max(32).default(''),
    vatNumber: z.string().max(32).default(''),
    note: z.string().max(1000).default(''),
    /** `null` : les valeurs de l'espace. */
    paymentTermsDays: z.number().int().min(0).max(365).nullable().default(null),
    defaultVatBp: vatRateBpSchema.nullable().default(null)
});

export type InvoicingClientInput = z.infer<typeof invoicingClientInputSchema>;

/**
 * La part scellée d'un client : tout ce qui l'identifie. C'est aussi la forme de
 * l'instantané recopié sur un document à son émission, qui doit montrer
 * éternellement l'adresse d'alors.
 */
export const invoicingClientContentSchema = invoicingClientInputSchema.omit({
    kind: true,
    paymentTermsDays: true,
    defaultVatBp: true
});

export type InvoicingClientContent = z.infer<typeof invoicingClientContentSchema>;

/** Ce qu'un client représente, et qui répond à « qui me doit quoi ». */
export const invoicingClientUsageSchema = z.object({
    documents: z.number().int().nonnegative(),
    billedCents: amountSchema,
    outstandingCents: amountSchema,
    overdueCents: amountSchema,
    lastIssuedOn: daySchema.nullable()
});

export const invoicingClientSchema = invoicingClientInputSchema.extend({
    id: z.number().int().positive(),
    archived: z.boolean(),
    usage: invoicingClientUsageSchema
});

export type InvoicingClient = z.infer<typeof invoicingClientSchema>;

/** Une ligne telle qu'elle est saisie. `id` nul : une ligne qui n'existe pas encore. */
export const invoicingLineInputSchema = z.object({
    id: z.number().int().positive().nullable(),
    kind: lineKindSchema,
    label: z.string().max(300),
    description: z.string().max(1000).default(''),
    quantityMilli: quantityMilliSchema,
    unit: lineUnitSchema,
    unitPrice: unitPriceSchema,
    vatRateBp: vatRateBpSchema
});

export type InvoicingLineInput = z.infer<typeof invoicingLineInputSchema>;

export const invoicingLineSchema = invoicingLineInputSchema.extend({
    id: z.number().int().positive(),
    /** Calculé par le serveur, et figé à l'émission. */
    netCents: amountSchema
});

export type InvoicingLine = z.infer<typeof invoicingLineSchema>;

export const invoicingVatShareSchema = z.object({
    rateBp: vatRateBpSchema,
    netCents: amountSchema,
    vatCents: amountSchema
});

export const invoicingTotalsSchema = z.object({
    netCents: amountSchema,
    vatCents: amountSchema,
    grossCents: amountSchema,
    /** Du taux le plus élevé au plus bas, comme se lit un pied de facture. */
    vat: z.array(invoicingVatShareSchema)
});

export type InvoicingTotals = z.infer<typeof invoicingTotalsSchema>;

/** Le statut affiché, dérivés compris. Voir `status.ts` : il ne se stocke pas. */
export const displayStatusSchema = z.enum([
    'draft',
    'sent',
    'issued',
    'accepted',
    'declined',
    'expired',
    'partial',
    'paid',
    'late',
    'cancelled'
]);

/** L'en-tête d'un document, ce que son brouillon laisse modifier. */
export const invoicingDocInputSchema = z.object({
    clientId: z.number().int().positive().nullable(),
    subject: z.string().max(200).default(''),
    intro: z.string().max(1000).default(''),
    notes: z.string().max(2000).default(''),
    terms: z.string().max(1000).default(''),
    purchaseOrder: z.string().max(80).default(''),
    performedOn: daySchema.nullable().default(null),
    /** Vides, ils se calculent à l'émission depuis les délais de l'espace. */
    dueOn: daySchema.nullable().default(null),
    validUntil: daySchema.nullable().default(null)
});

export type InvoicingDocInput = z.infer<typeof invoicingDocInputSchema>;

/**
 * La trace d'une acceptation en ligne. Elle vaut un « bon pour accord »
 * horodaté, pas une signature électronique qualifiée, et le document le dit.
 */
export const invoicingAcceptanceSchema = z.object({
    name: z.string().max(160),
    at: z.number().int().nonnegative(),
    ip: z.string().max(64).default(''),
    agent: z.string().max(200).default('')
});

/** La part scellée d'un document, hors instantanés. */
export const invoicingDocContentSchema = invoicingDocInputSchema
    .omit({ clientId: true, performedOn: true, dueOn: true, validUntil: true })
    .extend({ acceptance: invoicingAcceptanceSchema.nullable().default(null) });

export const invoicingDocSchema = invoicingDocInputSchema.extend({
    id: z.number().int().positive(),
    kind: documentKindSchema,
    status: documentStatusSchema,
    displayStatus: displayStatusSchema,
    /** Nul tant que le document est un brouillon : le numéro s'attribue à l'émission. */
    numberLabel: z.string().nullable(),
    /**
     * Le lien que le client suit, né avec l'émission et révocable. Nul sur un
     * brouillon, et nul si on l'a révoqué.
     */
    publicUrl: z.string().nullable(),
    /**
     * La réponse que le client a donnée en ligne : qui s'est prononcé, et quand.
     * Le statut dit laquelle des deux. Nulle si personne n'a répondu par le lien.
     */
    answer: invoicingAcceptanceSchema.pick({ name: true, at: true }).nullable(),
    /** Quand le document est parti par mail depuis DevEye, en secondes. */
    sentAt: z.number().int().nonnegative().nullable(),
    issuedOn: daySchema.nullable(),
    currency: currencySchema,
    vatRegime: vatRegimeSchema,
    /** Le nom du client, tel qu'il est aujourd'hui pour un brouillon, tel qu'il était pour un document émis. */
    clientName: z.string(),
    totals: invoicingTotalsSchema,
    /** Règlements, avoirs et acomptes déduits, additionnés. */
    settledCents: amountSchema,
    remainingCents: amountSchema,
    parentId: z.number().int().positive().nullable(),
    parentNumber: z.string().nullable(),
    updated: z.number().int().nonnegative()
});

export type InvoicingDoc = z.infer<typeof invoicingDocSchema>;

/** Ce que la liste totalise, sur tout le filtre et non sur la page. */
export const invoicingListTotalsSchema = z.object({
    count: z.number().int().nonnegative(),
    outstandingCents: amountSchema,
    overdueCents: amountSchema
});

/** Un règlement reçu. De la saisie, pas une pièce légale : cela se corrige et se retire. */
export const invoicingPaymentInputSchema = z.object({
    paidOn: daySchema,
    amountCents: amountSchema,
    method: paymentMethodSchema,
    reference: z.string().max(120).default(''),
    note: z.string().max(500).default('')
});

export type InvoicingPaymentInput = z.infer<typeof invoicingPaymentInputSchema>;

export const invoicingPaymentSchema = invoicingPaymentInputSchema.extend({
    id: z.number().int().positive()
});

export type InvoicingPayment = z.infer<typeof invoicingPaymentSchema>;

export const invoicingMonthSchema = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    billedCents: amountSchema,
    cashedCents: amountSchema
});

/**
 * Ce que le tableau de bord montre. Quatre chiffres, et un cinquième quand
 * l'espace est assujetti : ce sur quoi on agit aujourd'hui, pas un poster.
 */
export const invoicingDashboardSchema = z.object({
    currency: currencySchema,
    vatRegime: vatRegimeSchema,
    from: daySchema,
    to: daySchema,
    /** La trésorerie de la période, et celle de la précédente pour dire l'écart. */
    cashedCents: amountSchema,
    cashedBeforeCents: amountSchema,
    /**
     * La TVA portée par ces encaissements. Pour une prestation de services,
     * elle est due à l'encaissement et non à la facturation : ce chiffre suit
     * donc ce qui a été payé.
     */
    vatCollectedCents: amountSchema,
    billedCents: amountSchema,
    billedCount: z.number().int().nonnegative(),
    outstandingCents: amountSchema,
    overdueCents: amountSchema,
    overdueCount: z.number().int().nonnegative(),
    quotesPendingCents: amountSchema,
    quotesPendingCount: z.number().int().nonnegative(),
    quotesExpiringSoon: z.number().int().nonnegative(),
    months: z.array(invoicingMonthSchema),
    usage: invoicingQuotaUsageSchema.nullable()
});

export type InvoicingDashboard = z.infer<typeof invoicingDashboardSchema>;
