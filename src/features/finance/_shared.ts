import type {
    FinanceAccount,
    FinanceAccountBalanceRow,
    FinanceBudgetPeriod,
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
} from 'deveye-types';

import type { Cipher } from '@/Services/SecureStore';
import { FeatureError, type FeatureContext } from '../_define';

/**
 * Le socle de la feature Finances.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** Le livre de comptes appartient à
 * l'espace, et tout membre d'un espace partagé doit pouvoir le lire sans
 * dépendre du mot de passe de son propriétaire: c'est la condition pour qu'une
 * PME s'en serve à plusieurs. Corollaire pratique voulu, identique à celui des
 * bases de données et de l'audience: rien ici ne demande jamais de mot de passe.
 *
 * Ce que cela n'enlève pas: le contenu reste chiffré au repos, et le droit
 * `finance` reste le seul chemin d'accès. Ce qui change, c'est que la clé est
 * celle de l'espace et non celle d'une personne.
 */
export const READ = { feature: 'finance' } as const;
export const WRITE = { feature: 'finance', level: 'write' } as const;

/** Devise par défaut d'un espace qui n'a jamais rien réglé. */
export const DEFAULT_CURRENCY = 'EUR';

/**
 * Nombre maximal d'occurrences écrites pour une même échéance en un seul
 * rattrapage.
 *
 * Une échéance hebdomadaire laissée dix ans en arrière représenterait plus de
 * cinq cents écritures, dans une lecture que quelqu'un attend. Le plafond les
 * étale sur plusieurs lectures: chaque passage avance la date d'autant, donc
 * l'ensemble finit par être écrit, sans qu'aucune requête ne parte en vrille.
 */
const CATCH_UP_MAX = 120;

export function financeCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

/* ------------------------------------------------------------------ *
 * Charges chiffrées
 * ------------------------------------------------------------------ */

/** Ce que porte `finance_accounts.content`. */
export interface StoredAccount {
    name: string;
    note: string;
}

/** Ce que porte `finance_categories.content`. */
export interface StoredCategory {
    name: string;
}

/**
 * Ce que portent `finance_transactions.content` et `finance_recurring.content`.
 * Les deux tables partagent la charge parce qu'une échéance est le modèle d'une
 * opération: leur donner deux formes ferait diverger le jour où l'une gagne un
 * champ.
 */
export interface StoredEntry {
    label: string;
    counterparty: string;
    note: string;
}

export async function encryptJson(cipher: Cipher, payload: unknown): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * Relit une charge chiffrée, ou rend `null` si elle est illisible.
 *
 * Une ligne illisible (clé qui ne correspond plus, contenu abîmé) ne doit pas
 * faire échouer la lecture entière: un journal qui refuse de s'ouvrir pour une
 * ligne sur mille est bien pire qu'un journal auquel il manque une ligne, et
 * les nombres, eux, restent justes puisqu'ils sont en clair.
 */
export async function decryptJson<T>(cipher: Cipher, content: string): Promise<T | null> {
    const raw = await cipher.tryDecrypt(content);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Calendrier
 * ------------------------------------------------------------------ *
 *
 * Tout est fait sur des chaînes `AAAA-MM-JJ` et sur `Date.UTC`, jamais sur un
 * `Date` local: l'heure d'été décale un `Date` local d'une heure deux fois par
 * an, ce qui suffit à faire changer de jour un calcul fait près de minuit.
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
 * Ajoute des mois en reposant le **jour d'ancrage**, borné au dernier jour du
 * mois d'arrivée.
 *
 * C'est ce qui empêche une échéance au 31 de dériver: sans ancre, février la
 * ramène au 28 et elle y reste pour toujours, parce que le calcul suivant
 * repartirait de cette date-là.
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
 * La période en cours d'un budget, autour de `reference`.
 *
 * `end` est **exclu**: c'est le premier jour de la période suivante. Une borne
 * exclue rend la comparaison `date < end` juste sans se demander si le mois
 * compte 28, 30 ou 31 jours.
 */
export function periodBounds(period: FinanceBudgetPeriod, reference: string): { start: string; end: string } {
    const { year, month } = partsOf(reference);
    switch (period) {
        case 'monthly':
            return { start: isoOf(year, month, 1), end: addMonths(isoOf(year, month, 1), 1, 1) };
        case 'quarterly': {
            const first = Math.floor((month - 1) / 3) * 3 + 1;
            return { start: isoOf(year, first, 1), end: addMonths(isoOf(year, first, 1), 3, 1) };
        }
        case 'yearly':
            return { start: isoOf(year, 1, 1), end: isoOf(year + 1, 1, 1) };
    }
}

/**
 * La fenêtre analysée par le tableau de bord, et celle qui la précède.
 *
 * Les deux bornes sont **incluses**, parce que c'est ce qu'attendent les
 * requêtes du dépôt (`date >= from AND date <= to`). La fenêtre précédente a
 * exactement la même forme, de sorte que « +12 % » compare bien un mois à un
 * mois et non un mois à un mois et un jour.
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

/* ------------------------------------------------------------------ *
 * Réglages
 * ------------------------------------------------------------------ */

/**
 * Les réglages de l'espace, ou leurs valeurs par défaut.
 *
 * **N'écrit jamais.** Une lecture qui insère une ligne ferait qu'un membre en
 * lecture seule modifie la base en ouvrant un écran; la ligne n'apparaît qu'au
 * premier réglage effectivement enregistré.
 */
export async function readConfig(ctx: FeatureContext): Promise<FinanceConfig> {
    const row = await ctx.db.finance.getConfig(ctx.workspaceId);
    if (!row) return { currency: DEFAULT_CURRENCY, vatEnabled: false };
    return { currency: row.currency, vatEnabled: row.vat_enabled === 1 };
}

/* ------------------------------------------------------------------ *
 * Conversions ligne SQL vers DTO
 * ------------------------------------------------------------------ */

export function toAccount(row: FinanceAccountBalanceRow, payload: StoredAccount | null): FinanceAccount {
    return {
        id: row.id,
        name: payload?.name ?? '',
        kind: row.kind,
        color: row.color,
        initialBalance: Number(row.initial_balance),
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
    cipher: Cipher,
    rows: Row[],
    map: (row: Row, payload: Payload | null) => Out
): Promise<Out[]> {
    return Promise.all(rows.map(async (row) => map(row, await decryptJson<Payload>(cipher, row.content))));
}

/* ------------------------------------------------------------------ *
 * Cohérence d'une saisie
 * ------------------------------------------------------------------ */

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
 * Vérifie qu'une saisie tient debout, et que tout ce qu'elle désigne appartient
 * bien à l'espace.
 *
 * Les règles sont posées ici et pas dans le schéma zod parce qu'elles portent
 * sur des **relations** (ce compte existe-t-il, cette catégorie a-t-elle le bon
 * sens) que seul le serveur peut trancher. Ce que zod garantit déjà, en
 * revanche, n'est pas revérifié.
 */
export async function assertEntryConsistent(ctx: FeatureContext, entry: EntryShape): Promise<void> {
    // `findAccountPlain` et non `findAccount`: on ne veut ici qu'une existence,
    // et la seconde déroulerait l'agrégation de tous les mouvements de l'espace
    // à chaque saisie, pour un solde dont personne ne fait rien.
    const account = await ctx.db.finance.findAccountPlain(entry.accountId, ctx.workspaceId);
    if (!account) throw new FeatureError('not_found', 'Compte introuvable');

    if (entry.kind === 'transfer') {
        if (entry.transferAccountId === null) {
            throw new FeatureError('validation', 'Un virement demande un compte de destination.');
        }
        if (entry.transferAccountId === entry.accountId) {
            throw new FeatureError('validation', 'Un virement ne peut pas viser son propre compte de départ.');
        }
        const target = await ctx.db.finance.findAccountPlain(entry.transferAccountId, ctx.workspaceId);
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
        const category = await ctx.db.finance.findCategory(entry.categoryId, ctx.workspaceId);
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

/* ------------------------------------------------------------------ *
 * Rattrapage des échéances
 * ------------------------------------------------------------------ */

/** L'erreur MySQL d'une clé unique déjà prise. */
function isDuplicate(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/**
 * Écrit les occurrences dues des échéances **automatiques**, puis avance leur
 * date. Appelé en tête de chaque lecture de la feature.
 *
 * ## Pourquoi une matérialisation paresseuse et non une tâche de fond
 *
 * Une tâche de fond aurait demandé un ordonnanceur, un état en mémoire, et une
 * réponse à « que se passe-t-il si le serveur était éteint mardi ». Ici il n'y a
 * rien à ordonnancer: la première lecture qui suit la date écrit ce qui manque,
 * et rattrape autant de retard qu'il en reste. Un serveur arrêté un mois ne perd
 * rien, il écrit tout au redémarrage.
 *
 * Le coût quand il n'y a rien à faire, c'est-à-dire quasiment toujours, est
 * **une** requête servie par l'index `idx_finance_recurring_due`.
 *
 * ## Ce qui garantit qu'une occurrence n'est jamais écrite deux fois
 *
 * Deux lectures simultanées du même espace tomberaient toutes deux sur la même
 * échéance en retard. C'est l'index unique `(recurring_id, date)` qui tranche:
 * la seconde insertion est refusée, on la traite comme un succès, et les deux
 * lectures avancent l'échéance à la même date. Le contrôle est donc dans la
 * base, là où il est vrai, plutôt que dans un verrou applicatif qui ne
 * survivrait pas à deux instances du serveur.
 *
 * ## Les deux contreparties, assumées
 *
 * **Une lecture écrit.** Un membre en lecture seule qui ouvre l'écran peut donc
 * déclencher ces insertions. C'est voulu: l'alternative serait de lui montrer un
 * livre en retard parce qu'il n'a pas le droit d'écrire, alors que ce qui
 * s'écrit ici n'est pas sa saisie mais une conséquence mécanique d'un réglage
 * déjà validé par quelqu'un qui, lui, en avait le droit.
 *
 * **Rien n'est diffusé.** Un handler ne peut pas prévenir l'espace (`ctx.live`
 * n'expose délibérément pas `changed`, la diffusion appartient au dispatcheur et
 * à `mutates`), et déclarer `mutates` sur une lecture ferait diffuser à chaque
 * consultation. Conséquence concrète: l'écran d'un **autre** membre resté ouvert
 * ne verra le loyer apparaître qu'à sa prochaine lecture, laquelle rattrapera de
 * toute façon la même chose. Aucun chiffre n'est faux entre-temps, seulement
 * daté. Si un jour cela ne suffit plus, la forme à reprendre est celle des
 * services de fond (`UptimeMonitor`, `DatabaseMonitor`), qui tiennent le
 * `LiveHub` et diffusent eux-mêmes.
 */
export async function postDueRecurring(ctx: FeatureContext): Promise<void> {
    const now = today();
    const due = await ctx.db.finance.listDueRecurring(ctx.workspaceId, now, true);
    if (due.length === 0) return;

    const cipher = financeCipher(ctx);
    for (const row of due) {
        const payload = await decryptJson<StoredEntry>(cipher, row.content);
        if (!payload) {
            // Modèle illisible: on n'écrit pas une opération sans intitulé au
            // nom de quelqu'un. On la laisse en l'état, elle se verra dans la
            // liste des échéances.
            ctx.logger.warn({ recurringId: row.id }, 'finance: échéance illisible, rattrapage ignoré');
            continue;
        }

        let next = row.next_date;
        let lastPosted: string | null = null;
        let written = 0;

        while (next <= now && (row.end_date === null || next <= row.end_date) && written < CATCH_UP_MAX) {
            try {
                await ctx.db.finance.createTransaction(ctx.workspaceId, {
                    accountId: row.account_id,
                    transferAccountId: row.transfer_account_id,
                    categoryId: row.category_id,
                    recurringId: row.id,
                    kind: row.kind,
                    amount: Number(row.amount),
                    vatAmount: row.vat_amount === null ? null : Number(row.vat_amount),
                    date: next,
                    // Jamais pointée: personne n'a encore vu cette ligne sur un
                    // relevé, et la pointer d'office viderait le rapprochement
                    // bancaire de son seul intérêt.
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
        await ctx.db.finance.advanceRecurring(row.id, ctx.workspaceId, next, lastPosted, finished ? false : null);
    }
}
