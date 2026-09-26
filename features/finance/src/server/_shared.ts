import type {
    FinanceAccount,
    FinanceAccountBalanceRow,
    FinanceCategory,
    FinanceCategoryRow,
    FinanceConfig,
    FinanceFrequency,
    FinanceRange,
    FinanceRecurring,
    FinanceRecurringRow,
    FinanceTransaction,
    FinanceTransactionKind,
    FinanceTransactionRow
} from '../contracts/domain';
import { INVOICING_LEDGER_PROVIDER, type InvoicingLedgerProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { FinanceRepo } from './repo';

/** Le contexte d'une commande des Finances : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<FinanceRepo>;

/**
 * Ce dont le livre a besoin pour se tenir à jour, qu'une commande ou le service
 * de fond l'appelle : le service n'a pas de session, et n'offre que cela.
 */
export type LedgerIo = Pick<Ctx, 'repo' | 'workspaceId' | 'providers' | 'logger' | 'cipher'>;

/**
 * Un seul chiffre, l'étage ouvert : tout membre d'un espace partagé doit lire
 * le livre sans le mot de passe du propriétaire. La lecture est implicite ;
 * seules les écritures déclarent leur niveau.
 */
export const WRITE = { level: 'write' } as const;

/** La devise quand Facturation n'est pas là pour la dire. */
export const DEFAULT_CURRENCY = 'EUR';

/** La provenance d'une copie de règlement de Facturation (`finance_transactions.source`). */
export const INVOICING_SOURCE = 'invoicing';

/**
 * Plafond d'occurrences écrites par échéance en un rattrapage : une
 * hebdomadaire laissée dix ans en arrière s'étale sur plusieurs lectures.
 */
const CATCH_UP_MAX = 120;

/** L'étage ouvert du chiffrement. */
export function financeCipher(io: Pick<Ctx, 'cipher'>): SdkCipher {
    return io.cipher();
}

/** Ce que porte `finance_accounts.content`. */
export interface StoredAccount {
    name: string;
    note: string;
}

/** Ce que porte `finance_categories.content`. */
export interface StoredCategory {
    name: string;
}

/** Partagé par `finance_transactions` et `finance_recurring` : une échéance est le modèle d'une opération. */
export interface StoredEntry {
    label: string;
    counterparty: string;
    note: string;
    /** La facture d'une copie de règlement : de quoi la nommer et l'ouvrir. */
    origin?: { docNumber: string; segment: string };
}

/** Le livre de Facturation, ou `null` quand le module n'est pas là. */
export function invoicingLedger(ctx: Pick<Ctx, 'providers'>): InvoicingLedgerProvider | null {
    return ctx.providers.get<InvoicingLedgerProvider>(INVOICING_LEDGER_PROVIDER) ?? null;
}

export async function encryptJson(cipher: SdkCipher, payload: unknown): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * `null` si illisible : un journal qui refuse de s'ouvrir pour une ligne est
 * pire qu'un journal auquel il manque une ligne.
 */
export async function decryptJson<T>(cipher: SdkCipher, content: string): Promise<T | null> {
    const raw = await cipher.tryDecrypt(content);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/*
 * Calendrier sur des chaînes `AAAA-MM-JJ` et `Date.UTC`, jamais un `Date`
 * local : l'heure d'été ferait changer de jour un calcul près de minuit.
 */

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

export function isoOf(year: number, month: number, day: number): string {
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Découpe `AAAA-MM-JJ` en ses trois nombres. */
export function partsOf(value: string): { year: number; month: number; day: number } {
    return {
        year: Number(value.slice(0, 4)),
        month: Number(value.slice(5, 7)),
        day: Number(value.slice(8, 10))
    };
}

export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Le jour courant, tel que le voit le serveur. */
export function today(): string {
    const now = new Date();
    return isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function addDays(value: string, days: number): string {
    const { year, month, day } = partsOf(value);
    const at = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
    return isoOf(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/**
 * Ajoute des mois en reposant le jour d'ancrage, borné au dernier jour du
 * mois : sans ancre, février ramènerait une échéance au 28 pour toujours.
 */
export function addMonths(value: string, months: number, anchorDay: number | null): string {
    const { year, month, day } = partsOf(value);
    const total = year * 12 + (month - 1) + months;
    const nextYear = Math.floor(total / 12);
    const nextMonth = (total % 12) + 1;
    const wanted = anchorDay ?? day;
    return isoOf(nextYear, nextMonth, Math.min(wanted, daysInMonth(nextYear, nextMonth)));
}

/** Le premier jour du mois de `value`. */
export function startOfMonth(value: string): string {
    const { year, month } = partsOf(value);
    return isoOf(year, month, 1);
}

/** La prochaine occurrence d'une échéance après `from`. */
export function nextOccurrence(
    from: string,
    frequency: FinanceFrequency,
    interval: number,
    anchorDay: number | null
): string {
    switch (frequency) {
        case 'weekly':
            return addDays(from, 7 * interval);
        case 'monthly':
            return addMonths(from, interval, anchorDay);
        case 'quarterly':
            return addMonths(from, 3 * interval, anchorDay);
        case 'yearly':
            return addMonths(from, 12 * interval, anchorDay);
    }
}

/**
 * Bornes incluses (`date >= from AND date <= to`). La fenêtre précédente a la
 * même forme, pour comparer un mois à un mois.
 */
export function rangeBounds(
    range: FinanceRange,
    reference: string
): {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
} {
    const { year, month } = partsOf(reference);
    if (range === 'month') {
        const from = isoOf(year, month, 1);
        return {
            from,
            to: addDays(addMonths(from, 1, 1), -1),
            previousFrom: addMonths(from, -1, 1),
            previousTo: addDays(from, -1)
        };
    }
    if (range === 'quarter') {
        const first = Math.floor((month - 1) / 3) * 3 + 1;
        const from = isoOf(year, first, 1);
        return {
            from,
            to: addDays(addMonths(from, 3, 1), -1),
            previousFrom: addMonths(from, -3, 1),
            previousTo: addDays(from, -1)
        };
    }
    const from = isoOf(year, 1, 1);
    return {
        from,
        to: isoOf(year, 12, 31),
        previousFrom: isoOf(year - 1, 1, 1),
        previousTo: isoOf(year - 1, 12, 31)
    };
}

/**
 * N'écrit jamais : un membre en lecture seule ne doit pas modifier la base en
 * ouvrant un écran. La devise et la TVA sont celles de Facturation ; une panne
 * de sa part laisse le livre lisible, en euros et sans TVA.
 */
export async function readConfig(
    ctx: Pick<Ctx, 'repo' | 'workspaceId' | 'providers' | 'logger'>
): Promise<FinanceConfig> {
    const ledger = invoicingLedger(ctx);
    const [row, profile] = await Promise.all([
        ctx.repo.getConfig(ctx.workspaceId),
        ledger === null
            ? null
            : ledger.profile(ctx.workspaceId).catch((error: unknown) => {
                  ctx.logger.warn({ err: error }, 'finance: réglages de Facturation illisibles');
                  return null;
              })
    ]);
    return {
        currency: profile?.currency ?? DEFAULT_CURRENCY,
        vatEnabled: profile?.vatRegime === 'standard',
        invoicing: {
            available: ledger !== null,
            accountId: row?.invoicing_account_id ?? null,
            categoryId: row?.invoicing_category_id ?? null
        },
        status: {
            legalStatus: row?.legal_status ?? null,
            microActivity: row?.micro_activity ?? null,
            provisionRateBp: row?.provision_rate_bp ?? null,
            incomeTaxPrepaid: row?.income_tax_prepaid === 1,
            declarationPeriod: row?.declaration_period ?? null,
            trackingSince: row?.tracking_since ?? null
        }
    };
}

export function toAccount(row: FinanceAccountBalanceRow, payload: StoredAccount | null): FinanceAccount {
    return {
        id: row.id,
        name: payload?.name ?? '',
        kind: row.kind,
        color: row.color,
        initialBalance: Number(row.initial_balance),
        openedOn: row.opened_on,
        balance: Number(row.balance),
        projected: Number(row.projected),
        cleared: Number(row.cleared),
        transactionCount: Number(row.transaction_count),
        archived: row.archived === 1,
        note: payload?.note ?? '',
        sortOrder: row.sort_order,
        created: Number(row.created)
    };
}

export function toCategory(row: FinanceCategoryRow, payload: StoredCategory | null): FinanceCategory {
    return {
        id: row.id,
        name: payload?.name ?? '',
        flow: row.flow,
        color: row.color,
        icon: row.icon,
        role: row.role,
        sortOrder: row.sort_order
    };
}

export function toTransaction(row: FinanceTransactionRow, payload: StoredEntry | null): FinanceTransaction {
    return {
        id: row.id,
        accountId: row.account_id,
        kind: row.kind,
        amount: Number(row.amount),
        date: row.date,
        label: payload?.label ?? '',
        categoryId: row.category_id,
        transferAccountId: row.transfer_account_id,
        counterparty: payload?.counterparty ?? '',
        note: payload?.note ?? '',
        vatAmount: row.vat_amount === null ? null : Number(row.vat_amount),
        cleared: row.cleared === 1,
        recurringId: row.recurring_id,
        origin: row.source === INVOICING_SOURCE && payload?.origin ? payload.origin : null,
        created: Number(row.created),
        updated: Number(row.updated)
    };
}

export function toRecurring(row: FinanceRecurringRow, payload: StoredEntry | null): FinanceRecurring {
    return {
        id: row.id,
        accountId: row.account_id,
        kind: row.kind,
        amount: Number(row.amount),
        label: payload?.label ?? '',
        categoryId: row.category_id,
        transferAccountId: row.transfer_account_id,
        counterparty: payload?.counterparty ?? '',
        note: payload?.note ?? '',
        vatAmount: row.vat_amount === null ? null : Number(row.vat_amount),
        frequency: row.frequency,
        interval: row.interval_count,
        nextDate: row.next_date,
        endDate: row.end_date,
        automatic: row.automatic === 1,
        active: row.active === 1,
        lastPostedDate: row.last_posted_date,
        created: Number(row.created)
    };
}

/** Déchiffre une liste en parallèle, en gardant l'ordre reçu. */
export async function decryptAll<Row extends { content: string }, Payload, Out>(
    cipher: SdkCipher,
    rows: Row[],
    map: (row: Row, payload: Payload | null) => Out
): Promise<Out[]> {
    return Promise.all(rows.map(async (row) => map(row, await decryptJson<Payload>(cipher, row.content))));
}

/** La forme commune à une opération et au modèle d'une échéance. */
export interface EntryShape {
    accountId: number;
    kind: FinanceTransactionKind;
    amount: number;
    categoryId: number | null;
    transferAccountId: number | null;
    vatAmount: number | null;
}

/**
 * Les règles portent sur des relations (ce compte existe-t-il, la catégorie
 * a-t-elle le bon sens) que seul le serveur tranche.
 */
export async function assertEntryConsistent(ctx: Ctx, entry: EntryShape): Promise<void> {
    // `findAccountPlain` : une existence suffit, `findAccount` déroulerait
    // l'agrégation de tous les mouvements.
    const account = await ctx.repo.findAccountPlain(entry.accountId, ctx.workspaceId);
    if (!account) throw new FeatureError('not_found', 'Compte introuvable');

    if (entry.kind === 'transfer') {
        if (entry.transferAccountId === null) {
            throw new FeatureError('validation', 'Un virement demande un compte de destination.');
        }
        if (entry.transferAccountId === entry.accountId) {
            throw new FeatureError('validation', 'Un virement ne peut pas viser son propre compte de départ.');
        }
        const target = await ctx.repo.findAccountPlain(entry.transferAccountId, ctx.workspaceId);
        if (!target) throw new FeatureError('not_found', 'Compte de destination introuvable');
        // Un virement n'est ni une recette ni une dépense: il n'entre dans
        // aucune catégorie, et rien n'y est vendu ni acheté, donc pas de TVA.
        if (entry.categoryId !== null) {
            throw new FeatureError('validation', 'Un virement ne se classe pas dans une catégorie.');
        }
        if (entry.vatAmount !== null) {
            throw new FeatureError('validation', 'Un virement ne porte pas de TVA.');
        }
        return;
    }

    if (entry.transferAccountId !== null) {
        throw new FeatureError('validation', 'Seul un virement porte un compte de destination.');
    }
    if (entry.categoryId !== null) {
        const category = await ctx.repo.findCategory(entry.categoryId, ctx.workspaceId);
        if (!category) throw new FeatureError('not_found', 'Catégorie introuvable');
        if (category.flow !== entry.kind) {
            throw new FeatureError(
                'validation',
                category.flow === 'income'
                    ? 'Cette catégorie classe des recettes: elle ne peut pas porter une dépense.'
                    : 'Cette catégorie classe des dépenses: elle ne peut pas porter une recette.'
            );
        }
    }
    if (entry.vatAmount !== null && entry.vatAmount > entry.amount) {
        throw new FeatureError('validation', 'La TVA ne peut pas dépasser le montant.');
    }
}

/** Le jour d'ancrage d'une cadence, dérivé de sa première date. */
export function anchorDayOf(frequency: FinanceFrequency, date: string): number | null {
    return frequency === 'weekly' ? null : partsOf(date).day;
}

/** L'erreur MySQL d'une clé unique déjà prise. */
export function isDuplicate(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/**
 * Écrit les occurrences dues des échéances automatiques, puis avance leur
 * date. Appelé en tête de chaque lecture : matérialisation paresseuse plutôt
 * qu'une tâche de fond, un serveur arrêté un mois écrit tout au redémarrage.
 * Deux lectures simultanées tombent sur la même échéance : l'index unique
 * `(recurring_id, date)` refuse la seconde insertion, traitée comme un
 * succès. Une lecture écrit, donc un membre en lecture seule peut déclencher
 * ces insertions : conséquence d'un réglage validé par qui en avait le droit.
 * Rien n'est diffusé (une lecture ne déclare pas `mutates`) : l'écran d'un
 * autre membre ne verra le loyer qu'à sa prochaine lecture.
 */
export async function postDueRecurring(ctx: LedgerIo): Promise<void> {
    const now = today();
    const due = await ctx.repo.listDueRecurring(ctx.workspaceId, now, true);
    if (due.length === 0) return;

    const cipher = financeCipher(ctx);
    for (const row of due) {
        const payload = await decryptJson<StoredEntry>(cipher, row.content);
        if (!payload) {
            // Modèle illisible : on n'écrit pas une opération sans intitulé au nom de quelqu'un.
            ctx.logger.warn({ recurringId: row.id }, 'finance: échéance illisible, rattrapage ignoré');
            continue;
        }

        let next = row.next_date;
        let lastPosted: string | null = null;
        let written = 0;

        while (next <= now && (row.end_date === null || next <= row.end_date) && written < CATCH_UP_MAX) {
            try {
                await ctx.repo.createTransaction(ctx.workspaceId, {
                    accountId: row.account_id,
                    transferAccountId: row.transfer_account_id,
                    categoryId: row.category_id,
                    recurringId: row.id,
                    source: null,
                    sourceRef: null,
                    kind: row.kind,
                    amount: Number(row.amount),
                    vatAmount: row.vat_amount === null ? null : Number(row.vat_amount),
                    date: next,
                    // Jamais pointée : personne n'a encore vu cette ligne sur un relevé.
                    cleared: false,
                    content: row.content
                });
            } catch (error) {
                if (!isDuplicate(error)) throw error;
            }
            lastPosted = next;
            next = nextOccurrence(next, row.frequency, row.interval_count, row.anchor_day);
            written += 1;
        }

        // Arrivée au bout de sa fin de validité: elle s'éteint d'elle-même
        // plutôt que de rester à proposer une date qui ne viendra jamais.
        const finished = row.end_date !== null && next > row.end_date;
        await ctx.repo.advanceRecurring(row.id, ctx.workspaceId, next, lastPosted, finished ? false : null);
    }
}
