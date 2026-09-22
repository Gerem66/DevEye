import { z } from 'zod';

import {
    daySchema,
    documentKindSchema,
    documentStatusSchema,
    invoicingClientInputSchema,
    invoicingClientSchema,
    invoicingDocInputSchema,
    invoicingDocSchema,
    invoicingLineInputSchema,
    invoicingLineSchema,
    invoicingDashboardSchema,
    invoicingListTotalsSchema,
    invoicingPaymentInputSchema,
    invoicingPaymentSchema,
    invoicingQuotaUsageSchema,
    invoicingSettingsSchema,
    invoicingSummarySchema,
    invoicingTotalsSchema
} from './domain';

/** Ce que lit la carte de l'accueil. Aucune écriture, aucun droit au-delà de la lecture. */
export const invoicingCount = {
    command: 'invoicing.count' as const,
    input: z.object({}),
    output: z.object({ summary: invoicingSummarySchema })
};

/**
 * Les réglages de l'espace, et ce que l'offre permet ce mois-ci. `usage` est nul
 * quand aucune offre n'est installée.
 */
export const invoicingConfigGet = {
    command: 'invoicing.config' as const,
    input: z.object({}),
    output: z.object({
        settings: invoicingSettingsSchema,
        usage: invoicingQuotaUsageSchema.nullable()
    })
};

/**
 * L'enregistrement se fait en entier : chaque panneau renvoie les réglages tels
 * qu'il les a lus, la partie qu'il ne montre pas comprise. Une écriture
 * partielle par champ multiplierait les commandes et les validations sans rien
 * simplifier.
 */
export const invoicingConfigSave = {
    command: 'invoicing.configSave' as const,
    input: z.object({ settings: invoicingSettingsSchema }),
    output: z.object({ settings: invoicingSettingsSchema })
};

/**
 * Le carnet en entier : il se descelle et se trie côté client, parce que le nom
 * est scellé et qu'un chiffrement non déterministe ne se trie pas en SQL. D'où
 * la borne dure sur le nombre rendu.
 */
export const invoicingClientList = {
    command: 'invoicing.clientList' as const,
    input: z.object({ archived: z.boolean().default(false) }),
    output: z.object({ clients: z.array(invoicingClientSchema).max(500) })
};

/** `id: null` pour créer. Un seul verbe : deux commandes pour la même forme feraient deux fois les mêmes validations. */
export const invoicingClientSave = {
    command: 'invoicing.clientSave' as const,
    input: z.object({
        id: z.number().int().positive().nullable(),
        client: invoicingClientInputSchema,
        archived: z.boolean().default(false)
    }),
    output: z.object({ client: invoicingClientSchema })
};

/**
 * Le retrait définitif, refusé tant qu'un document porte ce client : la mise de
 * côté est le geste réversible que celui-ci n'est pas.
 */
export const invoicingClientRemove = {
    command: 'invoicing.clientRemove' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ ok: z.literal(true) })
};

/** Le journal, filtré. La recherche porte sur le numéro : le reste est scellé. */
export const invoicingDocList = {
    command: 'invoicing.docList' as const,
    input: z.object({
        kind: documentKindSchema.nullable().default(null),
        /** Le statut **stocké**, celui qu'un humain pose. */
        status: documentStatusSchema.nullable().default(null),
        /**
         * Les trois états qui ne se stockent pas, et qu'on cherche pourtant :
         * ce qui est en retard, ce qui reste à encaisser, ce qui a expiré. Le
         * dépôt les exprime, il ne les lit pas.
         */
        derived: z.enum(['overdue', 'unpaid', 'expired']).nullable().default(null),
        clientId: z.number().int().positive().nullable().default(null),
        year: z.number().int().min(2000).max(2100).nullable().default(null),
        search: z.string().max(64).default(''),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0)
    }),
    output: z.object({
        docs: z.array(invoicingDocSchema),
        totals: invoicingListTotalsSchema
    })
};

/** Un document et tout ce qui s'y rattache, en une lecture. */
export const invoicingDocGet = {
    command: 'invoicing.doc' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({
        doc: invoicingDocSchema,
        lines: z.array(invoicingLineSchema),
        payments: z.array(invoicingPaymentSchema)
    })
};

/** `id: null` pour créer un brouillon. Au-delà du brouillon, l'en-tête ne bouge plus. */
export const invoicingDocSave = {
    command: 'invoicing.docSave' as const,
    input: z.object({
        id: z.number().int().positive().nullable(),
        kind: documentKindSchema,
        doc: invoicingDocInputSchema
    }),
    output: z.object({ doc: invoicingDocSchema })
};

/**
 * Toutes les lignes d'un coup, et non un verbe par ligne : un panneau, un
 * enregistrement, un état. Le serveur fait la différence par identifiant, il ne
 * vide jamais la table avant de la remplir : sans transaction, un arrêt entre
 * les deux perdrait tout.
 */
export const invoicingLinesSet = {
    command: 'invoicing.linesSet' as const,
    input: z.object({
        docId: z.number().int().positive(),
        lines: z.array(invoicingLineInputSchema).max(200)
    }),
    output: z.object({
        lines: z.array(invoicingLineSchema),
        totals: invoicingTotalsSchema
    })
};

/**
 * L'émission : le geste qui numérote, fige et engage. Il consomme le quota de
 * l'offre, et c'est le seul de cet écran qui soit irréversible.
 */
export const invoicingDocIssue = {
    command: 'invoicing.docIssue' as const,
    input: z.object({
        id: z.number().int().positive(),
        /** Vide : aujourd'hui, dans le fuseau de l'espace. */
        issuedOn: daySchema.nullable().default(null)
    }),
    output: z.object({ doc: invoicingDocSchema })
};

/** La suite d'un devis : accepté, refusé. Une facture, elle, ne change pas d'état à la main. */
export const invoicingDocStatus = {
    command: 'invoicing.docStatus' as const,
    input: z.object({
        id: z.number().int().positive(),
        status: z.enum(['accepted', 'declined'])
    }),
    output: z.object({ doc: invoicingDocSchema })
};

/**
 * Le document imprimable, en HTML autonome. La même chaîne sert l'aperçu,
 * l'impression, la page publique et le corps du courriel : une seule mise en
 * page, donc aucune divergence possible.
 */
export const invoicingPaper = {
    command: 'invoicing.paper' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ html: z.string() })
};

/**
 * Dériver une pièce d'une autre : la facture d'un devis, l'acompte d'un devis,
 * l'avoir d'une facture. Un seul verbe, parce que c'est un seul geste : on
 * repart de ce qui existe, et le brouillon obtenu se corrige avant émission.
 */
export const invoicingDocDerive = {
    command: 'invoicing.docDerive' as const,
    input: z.object({
        id: z.number().int().positive(),
        mode: z.enum(['invoice', 'deposit', 'credit']),
        /** Pour un acompte seulement : la part du devis, en points de base (3000 vaut 30 %). */
        percentBp: z.number().int().min(1).max(10_000).default(3000)
    }),
    output: z.object({ doc: invoicingDocSchema })
};

/**
 * Le lien public d'un document : un jeton aléatoire, révocable, qui voyage dans
 * un courriel. Ce n'est pas un ticket de session, lequel expire en secondes.
 */
export const invoicingShare = {
    command: 'invoicing.share' as const,
    input: z.object({ id: z.number().int().positive(), revoke: z.boolean().default(false) }),
    output: z.object({ url: z.string().nullable() })
};

/**
 * L'envoi au client, par un compte mail de l'espace. Le document part en HTML
 * dans le corps du message, avec le lien vers sa page : le PDF n'existe que dans
 * le navigateur, et une pièce jointe demanderait un moteur de rendu serveur.
 */
export const invoicingSend = {
    command: 'invoicing.send' as const,
    input: z.object({
        id: z.number().int().positive(),
        /** Vide : l'adresse du client. */
        to: z.string().max(160).default(''),
        message: z.string().max(2000).default('')
    }),
    output: z.object({ sent: z.boolean(), to: z.string() })
};

/** Les comptes mail de l'espace qui savent expédier, pour le choix de l'expéditeur. */
export const invoicingMailAccounts = {
    command: 'invoicing.mailAccounts' as const,
    input: z.object({}),
    output: z.object({
        senders: z.array(z.object({ id: z.number().int().positive(), label: z.string(), address: z.string() }))
    })
};

/** Un règlement reçu. `id: null` pour l'ajouter. */
export const invoicingPaymentSave = {
    command: 'invoicing.paymentSave' as const,
    input: z.object({
        docId: z.number().int().positive(),
        payment: invoicingPaymentInputSchema
    }),
    output: z.object({
        doc: invoicingDocSchema,
        payments: z.array(invoicingPaymentSchema)
    })
};

export const invoicingPaymentRemove = {
    command: 'invoicing.paymentRemove' as const,
    input: z.object({
        docId: z.number().int().positive(),
        id: z.number().int().positive()
    }),
    output: z.object({
        doc: invoicingDocSchema,
        payments: z.array(invoicingPaymentSchema)
    })
};

/**
 * Toute la page d'accueil de la feature, en **une** lecture : les chiffres, ce
 * qui demande un geste, les derniers documents et les derniers clients. Cinq
 * lectures séparées laisseraient un écran qui se compose sous les yeux, et deux
 * d'entre elles pourraient se contredire d'une seconde.
 */
export const invoicingDashboard = {
    command: 'invoicing.dashboard' as const,
    input: z.object({
        range: z.enum(['month', 'quarter', 'year']).default('month'),
        /** Combien de documents et de clients la page d'accueil montre. */
        recent: z.number().int().min(1).max(20).default(5)
    }),
    output: z.object({
        dashboard: invoicingDashboardSchema,
        actionable: z.array(invoicingDocSchema),
        recentDocs: z.array(invoicingDocSchema),
        recentClients: z.array(invoicingClientSchema)
    })
};

/** Un brouillon sans numéro, et rien d'autre : un document émis ne se supprime pas. */
export const invoicingDocRemove = {
    command: 'invoicing.docRemove' as const,
    input: z.object({ id: z.number().int().positive() }),
    output: z.object({ ok: z.literal(true) })
};

export const invoicingCommands = [
    invoicingCount,
    invoicingConfigGet,
    invoicingConfigSave,
    invoicingClientList,
    invoicingClientSave,
    invoicingClientRemove,
    invoicingDocList,
    invoicingDocGet,
    invoicingDocSave,
    invoicingLinesSet,
    invoicingDocIssue,
    invoicingDocStatus,
    invoicingPaper,
    invoicingDocDerive,
    invoicingShare,
    invoicingSend,
    invoicingMailAccounts,
    invoicingPaymentSave,
    invoicingPaymentRemove,
    invoicingDashboard,
    invoicingDocRemove
] as const;
