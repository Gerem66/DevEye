import { financeOverview } from '../../contracts/commands';
import type { InvoicingLedgerReceivable } from '@deveye/types/sdk';
import type { FinanceForecastPoint, FinanceMonthPoint, FinanceOverview, FinanceUpcoming } from '../../contracts/domain';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import {
    addDays,
    addMonths,
    decryptAll,
    decryptJson,
    financeCipher,
    invoicingLedger,
    nextOccurrence,
    rangeBounds,
    readConfig,
    startOfMonth,
    toTransaction,
    today,
    type Ctx,
    type StoredEntry
} from '../_shared';
import { catchUp } from '../sources';
import { computeStatus, microPaymentsDue } from '../status';

/** Le tableau de bord en une réponse : ces chiffres doivent être cohérents entre eux. */

/** Combien de mois la frise couvre. Un an, pour que la saisonnalité se voie. */
const SERIES_MONTHS = 12;

/** Jusqu'où l'on annonce les échéances à venir. */
const UPCOMING_DAYS = 45;
const UPCOMING_MAX = 8;

const RECENT_MAX = 5;

/** Combien de factures l'accueil nomme ; les autres ne comptent que dans le total. */
const RECEIVABLES_SHOWN = 8;

/** Le mois en cours et les deux suivants. */
const FORECAST_MONTHS = 3;

/** Garde-fou d'une échéance hebdomadaire mal réglée : au-delà, la prévision a de toute façon dit l'essentiel. */
const FORECAST_OCCURRENCES_MAX = 60;

/**
 * La courbe du solde : le solde à la veille de la fenêtre, puis les flux de
 * chaque mois (un virement s'annule). Les mois vides sont reconstitués : un
 * `GROUP BY` ne rend que ce qui existe.
 */
async function buildSeries(ctx: Ctx, endMonth: string): Promise<FinanceMonthPoint[]> {
    const lastStart = startOfMonth(endMonth);
    const firstStart = addMonths(lastStart, -(SERIES_MONTHS - 1), 1);
    const lastDay = addDays(addMonths(lastStart, 1, 1), -1);

    const [flows, opening] = await Promise.all([
        ctx.repo.monthlyFlow(ctx.workspaceId, firstStart, lastDay),
        ctx.repo.totalBalance(ctx.workspaceId, addDays(firstStart, -1))
    ]);

    const byMonth = new Map(flows.map((row) => [row.month, row]));
    const points: FinanceMonthPoint[] = [];
    let running = opening;
    for (let i = 0; i < SERIES_MONTHS; i++) {
        const start = addMonths(firstStart, i, 1);
        const month = start.slice(0, 7);
        const flow = byMonth.get(month);
        const income = flow?.income ?? 0;
        const expense = flow?.expense ?? 0;
        running += income - expense;
        points.push({ month, income, expense, balance: running });
    }
    return points;
}

/** Les échéances attendues dans les prochaines semaines, retards compris. */
async function buildUpcoming(ctx: Ctx, now: string): Promise<FinanceUpcoming[]> {
    const rows = await ctx.repo.listDueRecurring(ctx.workspaceId, addDays(now, UPCOMING_DAYS));
    const cipher = financeCipher(ctx);
    const upcoming = await Promise.all(
        rows.slice(0, UPCOMING_MAX).map(async (row) => {
            const payload = await decryptJson<StoredEntry>(cipher, row.content);
            return {
                recurringId: row.id,
                date: row.next_date,
                label: payload?.label ?? '',
                kind: row.kind,
                amount: Number(row.amount),
                accountId: row.account_id,
                categoryId: row.category_id,
                automatic: row.automatic === 1,
                // Une automatique en retard n'existe pas (le rattrapage vient de
                // tourner) : ne restent en retard que les manuelles.
                overdue: row.next_date < now
            } satisfies FinanceUpcoming;
        })
    );
    return upcoming;
}

/** Ce que les factures émises attendent encore, dans la devise du livre. Une panne de Facturation n'en montre rien. */
async function readReceivables(ctx: Ctx, currency: string): Promise<InvoicingLedgerReceivable[] | null> {
    const ledger = invoicingLedger(ctx);
    if (ledger === null) return null;
    try {
        const all = await ledger.receivables(ctx.workspaceId);
        return all.filter((receivable) => receivable.currency === currency);
    } catch (error) {
        ctx.logger.warn({ err: error }, 'finance: créances de Facturation illisibles');
        return null;
    }
}

function summarize(receivables: InvoicingLedgerReceivable[] | null): FinanceOverview['receivables'] {
    if (receivables === null) return null;
    const overdue = receivables.filter((receivable) => receivable.overdue);
    return {
        total: receivables.reduce((sum, receivable) => sum + receivable.remainingCents, 0),
        overdue: overdue.reduce((sum, receivable) => sum + receivable.remainingCents, 0),
        count: receivables.length,
        overdueCount: overdue.length,
        items: receivables.slice(0, RECEIVABLES_SHOWN).map((receivable) => ({
            docNumber: receivable.docNumber,
            clientName: receivable.clientName,
            dueOn: receivable.dueOn,
            remaining: receivable.remainingCents,
            overdue: receivable.overdue,
            segment: receivable.segment
        }))
    };
}

/** La fin de la prévision : le dernier jour du dernier mois qu'elle couvre. */
function forecastHorizon(now: string): string {
    return addDays(addMonths(startOfMonth(now), FORECAST_MONTHS, 1), -1);
}

/**
 * Le solde attendu à la fin du mois en cours et des deux suivants, à partir de
 * celui du jour. Entre ce qui est déjà saisi à une date future, les
 * occurrences des échéances actives, les factures à leur échéance, et sortent
 * les versements URSSAF à la leur. Ce qui est déjà en retard (une facture
 * échue, une échéance manuelle pas encore enregistrée) tombe dans le mois en
 * cours : on l'attend maintenant.
 */
async function buildForecast(
    ctx: Ctx,
    now: string,
    balance: number,
    receivables: InvoicingLedgerReceivable[] | null,
    payments: readonly { date: string; amount: number }[]
): Promise<FinanceForecastPoint[]> {
    const first = startOfMonth(now);
    const months = Array.from({ length: FORECAST_MONTHS }, (_, i) => addMonths(first, i, 1).slice(0, 7));
    const horizon = forecastHorizon(now);
    const flows = new Map(months.map((month) => [month, { incoming: 0, outgoing: 0 }]));
    const bucket = (date: string) => flows.get(date <= now ? months[0] : date.slice(0, 7));

    const [recorded, recurring] = await Promise.all([
        ctx.repo.monthlyFlow(ctx.workspaceId, addDays(now, 1), horizon),
        ctx.repo.listRecurring(ctx.workspaceId)
    ]);

    for (const row of recorded) {
        const flow = flows.get(row.month);
        if (!flow) continue;
        flow.incoming += row.income;
        flow.outgoing += row.expense;
    }

    for (const row of recurring) {
        if (row.active !== 1 || row.kind === 'transfer') continue;
        let date = row.next_date;
        for (let n = 0; n < FORECAST_OCCURRENCES_MAX && date <= horizon; n++) {
            if (row.end_date !== null && date > row.end_date) break;
            const flow = bucket(date);
            if (flow && row.kind === 'income') flow.incoming += Number(row.amount);
            if (flow && row.kind === 'expense') flow.outgoing += Number(row.amount);
            date = nextOccurrence(date, row.frequency, row.interval_count, row.anchor_day);
        }
    }

    for (const receivable of receivables ?? []) {
        const due = receivable.dueOn ?? now;
        if (due > horizon) continue;
        const flow = bucket(due);
        if (flow) flow.incoming += receivable.remainingCents;
    }

    for (const payment of payments) {
        const flow = bucket(payment.date);
        if (flow) flow.outgoing += payment.amount;
    }

    let running = balance;
    return months.map((month) => {
        const flow = flows.get(month) ?? { incoming: 0, outgoing: 0 };
        running += flow.incoming - flow.outgoing;
        return { month, incoming: flow.incoming, outgoing: flow.outgoing, balance: running };
    });
}

export const financeOverviewFeature = defineSdkFeature({
    ...financeOverview,
    handler: async (ctx: Ctx, input) => {
        await catchUp(ctx);
        const now = today();
        const { from, to, previousFrom, previousTo } = rangeBounds(input.range, now);
        const config = await readConfig(ctx);

        const [netBalance, savings, projected, current, previous, categories, months, upcoming, recentRows, vatTotals] =
            await Promise.all([
                ctx.repo.totalBalance(ctx.workspaceId, now),
                // L'épargne à part : 7 000 bloqués sur un livret ne sont pas du disponible.
                ctx.repo.totalBalance(ctx.workspaceId, now, ['savings']),
                ctx.repo.projectedBalance(ctx.workspaceId),
                ctx.repo.sumTransactions(ctx.workspaceId, { from, to }),
                ctx.repo.sumTransactions(ctx.workspaceId, { from: previousFrom, to: previousTo }),
                ctx.repo.categoryShares(ctx.workspaceId, from, to),
                buildSeries(ctx, now),
                buildUpcoming(ctx, now),
                ctx.repo.listTransactions(ctx.workspaceId, { to: now }, RECENT_MAX, 0),
                ctx.repo.vatTotals(ctx.workspaceId, from, to)
            ]);
        const receivables = await readReceivables(ctx, config.currency);
        const [status, payments] = await Promise.all([
            computeStatus(ctx, config.status, config.vatEnabled, now, netBalance, receivables),
            microPaymentsDue(ctx, config.status, now, forecastHorizon(now))
        ]);
        const forecast = await buildForecast(ctx, now, netBalance, receivables, payments);

        return {
            overview: {
                currency: config.currency,
                from,
                to,
                netBalance,
                savings,
                projected,
                income: current.income,
                expense: current.expense,
                net: current.income - current.expense,
                previousIncome: previous.income,
                previousExpense: previous.expense,
                months,
                categories: categories.map((row) => ({
                    categoryId: row.category_id,
                    flow: row.flow,
                    amount: row.amount,
                    count: row.count
                })),
                upcoming,
                recent: await decryptAll(financeCipher(ctx), recentRows, toTransaction),
                receivables: summarize(receivables),
                forecast,
                status,
                // `null` plutôt que des zéros quand la TVA n'est pas suivie :
                // il n'y en a pas « zéro ».
                vat: config.vatEnabled
                    ? {
                          collected: vatTotals.collected,
                          deductible: vatTotals.deductible,
                          due: vatTotals.collected - vatTotals.deductible
                      }
                    : null
            }
        };
    }
});
