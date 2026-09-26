import { z } from 'zod';

import { financeDateSchema } from './domain';

/**
 * Les connexions bancaires directes : une source de lignes de relevé de plus,
 * qui passe par le même rapprochement qu'un fichier importé. Qonto se relie par
 * une clé d'API ; les autres banques par Enable Banking, quand l'instance a
 * enregistré son application.
 */

export const bankProviderSchema = z.enum(['qonto', 'enablebanking']);
export type BankProvider = z.infer<typeof bankProviderSchema>;

/** Toutes les combien d'heures une connexion se relève d'elle-même. */
export const BANK_SYNC_HOURS = 6;

export const BANK_LABEL_MAX_LENGTH = 80;

/**
 * `ok` : la dernière relève a abouti. `error` : la banque a refusé ou n'a pas
 * répondu, la suivante réessaiera. `expired` : le consentement donné à la
 * banque a pris fin, seule une reconnexion la relance.
 */
export const bankConnectionStatusSchema = z.enum(['ok', 'error', 'expired']);
export type BankConnectionStatus = z.infer<typeof bankConnectionStatusSchema>;

export const bankPsuTypeSchema = z.enum(['business', 'personal']);
export type BankPsuType = z.infer<typeof bankPsuTypeSchema>;

/** Un compte tel que la banque le montre : ce qu'un compte du livre choisit. */
export const bankRemoteAccountSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string(),
    /** Les quatre derniers chiffres seulement, pour reconnaître le compte sans exposer l'IBAN. */
    ibanEnd: z.string(),
    currency: z.string()
});
export type BankRemoteAccount = z.infer<typeof bankRemoteAccountSchema>;

export const bankConnectionSchema = z.object({
    id: z.number().int().positive(),
    provider: bankProviderSchema,
    label: z.string(),
    /** Le nom de la banque : « Qonto », ou celle choisie chez Enable Banking. */
    bankName: z.string(),
    /** Enable Banking : de quoi reconnecter la même banque en un clic. `null` pour Qonto. */
    country: z.string().nullable(),
    psuType: bankPsuTypeSchema.nullable(),
    status: bankConnectionStatusSchema,
    /** Ce que la dernière relève a buté, en une phrase. */
    error: z.string().nullable(),
    /** Secondes Unix. La fin du consentement, pour une banque reliée par Enable Banking. */
    validUntil: z.number().int().nullable(),
    lastSyncAt: z.number().int().nullable(),
    accounts: z.array(bankRemoteAccountSchema),
    /** Mise en pause par l'offre de son propriétaire : rien ne se relève. */
    paused: z.boolean(),
    created: z.number().int()
});
export type BankConnection = z.infer<typeof bankConnectionSchema>;

/** Un compte du livre relié à un compte de la banque. */
export const bankLinkSchema = z.object({
    accountId: z.number().int().positive(),
    connectionId: z.number().int().positive(),
    externalAccountId: z.string(),
    /** Le premier jour relevé : ce qui précède vient des imports, ou du solde de départ. */
    since: financeDateSchema
});
export type BankLink = z.infer<typeof bankLinkSchema>;

/** Une banque que propose Enable Banking dans un pays. */
export const bankInstitutionSchema = z.object({
    name: z.string(),
    country: z.string().length(2),
    psuTypes: z.array(bankPsuTypeSchema)
});
export type BankInstitution = z.infer<typeof bankInstitutionSchema>;

/** Les pays où la connexion par Enable Banking se propose, la France d'abord. */
export const BANK_COUNTRIES = [
    { code: 'FR', label: 'France' },
    { code: 'BE', label: 'Belgique' },
    { code: 'LU', label: 'Luxembourg' },
    { code: 'DE', label: 'Allemagne' },
    { code: 'ES', label: 'Espagne' },
    { code: 'IT', label: 'Italie' },
    { code: 'NL', label: 'Pays-Bas' },
    { code: 'PT', label: 'Portugal' }
] as const;

/* Ligne SQL (serveur uniquement). */

export interface FinanceConnectionRow {
    id: number;
    workspace_id: number;
    provider: BankProvider;
    status: BankConnectionStatus;
    error: string | null;
    valid_until: number | null;
    /** Le `valid_until` pour lequel l'avis d'expiration est parti. */
    warned_until: number | null;
    last_sync_at: number | null;
    /** `{ label, bankName, secret, accounts }` chiffré, étage ouvert : le service de fond le lit sans session. */
    content: string;
    created: number;
}

export interface FinanceBankLinkRow {
    account_id: number;
    workspace_id: number;
    connection_id: number;
    external_account_id: string;
    /** `AAAA-MM-JJ`, projeté par `DATE_FORMAT`. */
    since: string;
}
