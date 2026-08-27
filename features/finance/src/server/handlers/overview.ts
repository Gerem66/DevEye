import { financeOverview } from '../../contracts/commands';
import type { FinanceMonthPoint, FinanceUpcoming } from '../../contracts/domain';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import {
    addDays,
    addMonths,
    decryptJson,
    financeCipher,
    postDueRecurring,
    rangeBounds,
    readConfig,
    startOfMonth,
    today,
    type Ctx,
    type StoredEntry
} from '../_shared';
import { withConsumption } from './budgets';

/**
 * Le tableau de bord: tout ce qu'on lit d'un coup d'œil, en une réponse.
 *
 * Une seule commande et non six, parce que ces chiffres se lisent **ensemble**
 * et doivent être cohérents entre eux. Six allers-retours indépendants
 * laisseraient un écran où le solde vient d'avant une écriture et la répartition
 * d'après, et personne ne saurait laquelle des deux moitiés croire.
 */

/** Combien de mois la frise couvre. Un an, pour que la saisonnalité se voie. */
const SERIES_MONTHS = 12;

/** Jusqu'où l'on annonce les échéances à venir. */
const UPCOMING_DAYS = 45;
const UPCOMING_MAX = 8;

/**
 * La courbe du solde, mois par mois.
 *
 * Reconstituée depuis un **point de départ** plutôt que par douze requêtes de
 * solde: on demande le solde à la veille de la fenêtre, puis on lui ajoute les
 * flux de chaque mois. Un virement n'y change rien par construction, puisqu'il
 * sort d'une poche pour entrer dans une autre et que la somme des deux est nulle
 * une fois tous les comptes réunis.
 *
 * Les mois sans la moindre opération ne remontent pas de SQL (un `GROUP BY` ne
 * rend que ce qui existe): la grille est reconstituée complète, sans quoi deux
 * mois séparés par un trou se toucheraient et la courbe mentirait sur le rythme.
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
                // Une automatique en retard n'existe pas: le rattrapage vient de
                // tourner juste au-dessus. Ne restent en retard que les
                // manuelles, celles qui attendent un clic, et le dire les fait
                // remonter en tête de liste dans l'écran.
                overdue: row.next_date < now
            } satisfies FinanceUpcoming;
        })
    );
    return upcoming;
}

export const financeOverviewFeature = defineSdkFeature({
    ...financeOverview,
    handler: async (ctx: Ctx, input) => {
        await postDueRecurring(ctx);
        const now = today();
        const { from, to, previousFrom, previousTo } = rangeBounds(input.range, now);
        const config = await readConfig(ctx);

        const [netBalance, savings, projected, current, previous, categories, months, budgetRows, upcoming, vatTotals] =
            await Promise.all([
                ctx.repo.totalBalance(ctx.workspaceId, now),
                // L'épargne à part: avoir 8 000 € dont 7 000 bloqués sur un livret
                // n'est pas la même situation que 8 000 € sur un compte courant, et
                // c'est la première chose qu'on veut savoir en regardant un total.
                ctx.repo.totalBalance(ctx.workspaceId, now, ['savings']),
                ctx.repo.projectedBalance(ctx.workspaceId),
                ctx.repo.sumTransactions(ctx.workspaceId, { from, to }),
                ctx.repo.sumTransactions(ctx.workspaceId, { from: previousFrom, to: previousTo }),
                ctx.repo.categoryShares(ctx.workspaceId, from, to),
                buildSeries(ctx, to),
                ctx.repo.listBudgets(ctx.workspaceId),
                buildUpcoming(ctx, now),
                ctx.repo.vatTotals(ctx.workspaceId, from, to)
            ]);

        const budgets = await Promise.all(budgetRows.map((row) => withConsumption(ctx, row)));

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
                budgets,
                upcoming,
                // Hors mode entreprise, `null` plutôt que des zéros: un
                // récapitulatif de TVA à zéro laisserait croire qu'il n'y en a
                // pas eu, là où la vérité est qu'on ne la suit pas.
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
