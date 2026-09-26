import type { InvoicingLedgerReceivable } from '@deveye/types/sdk';

import type { FinanceStatus, FinanceStatusSettings } from '../contracts/domain';
import {
    applyBp,
    microRates,
    microThresholds,
    periodOf,
    previousPeriod,
    type DeclarationPeriod,
    type MicroActivity,
    type Period
} from '../contracts/legal';
import { startOfMonth, type Ctx } from './_shared';

/**
 * Ce que le statut fait dire à l'accueil : la déclaration à faire, ce qu'il
 * faut mettre de côté, le disponible réel, les seuils. Des estimations : le
 * chiffre d'affaires est celui du livre, la déclaration fait foi.
 *
 * Les cotisations d'une micro-entreprise se comptent par période, sans rien
 * demander d'autre : celles de la période en cours, plus celles de la période
 * close tant que son échéance n'est pas passée (après, on les suppose payées).
 * La TVA et la part du bénéfice d'une entreprise n'ont pas de calendrier aussi
 * simple : elles s'additionnent depuis le jour de suivi, moins ce qui a été
 * versé depuis dans les catégories qui les paient.
 */

type StatusIo = Pick<Ctx, 'repo' | 'workspaceId'>;

/** La part du bénéfice qu'une entreprise garde quand personne n'a dit laquelle. */
export const DEFAULT_COMPANY_PROVISION_BP = 2_500;

/** Ce qu'une micro-entreprise règle au statut : sans activité ni cadence, rien ne se calcule. */
export interface MicroSettings {
    activity: MicroActivity;
    period: DeclarationPeriod;
    socialOverrideBp: number | null;
    incomeTaxPrepaid: boolean;
}

export function microSettingsOf(settings: FinanceStatusSettings): MicroSettings | null {
    if (settings.legalStatus !== 'micro' || settings.microActivity === null || settings.declarationPeriod === null) {
        return null;
    }
    return {
        activity: settings.microActivity,
        period: settings.declarationPeriod,
        socialOverrideBp: settings.provisionRateBp,
        incomeTaxPrepaid: settings.incomeTaxPrepaid
    };
}

/** La période que couvre la prochaine déclaration : la close dont l'échéance n'est pas passée, sinon celle en cours. */
export function declarationTarget(now: string, period: DeclarationPeriod): { period: Period; closed: boolean } {
    const current = periodOf(now, period);
    const previous = previousPeriod(current, period);
    return now <= previous.deadline ? { period: previous, closed: true } : { period: current, closed: false };
}

/** Le chiffre d'affaires d'une période, jusqu'à aujourd'hui, et ce qu'il appelle. */
export async function periodFigures(
    io: StatusIo,
    micro: MicroSettings,
    period: Period,
    now: string
): Promise<{ revenue: number; contributions: number; incomeTax: number }> {
    const to = period.to < now ? period.to : now;
    const revenue = period.from > now ? 0 : await io.repo.revenueBetween(io.workspaceId, period.from, to);
    const rates = microRates(micro.activity, period.from, {
        socialOverrideBp: micro.socialOverrideBp,
        incomeTaxPrepaid: micro.incomeTaxPrepaid
    });
    return {
        revenue,
        contributions: applyBp(revenue, rates.socialBp),
        incomeTax: applyBp(revenue, rates.incomeTaxBp)
    };
}

/** La TVA due depuis le jour de suivi, moins celle déjà reversée. */
async function vatToSetAside(io: StatusIo, since: string, now: string): Promise<number> {
    const [totals, paid] = await Promise.all([
        io.repo.vatTotals(io.workspaceId, since, now),
        io.repo.paidByRoles(io.workspaceId, ['vat'], since, now)
    ]);
    return Math.max(0, totals.collected - totals.deductible - paid);
}

export async function computeStatus(
    io: StatusIo,
    settings: FinanceStatusSettings,
    vatEnabled: boolean,
    now: string,
    balance: number,
    receivables: readonly InvoicingLedgerReceivable[] | null
): Promise<FinanceStatus | null> {
    if (settings.legalStatus === null) return null;
    const since = settings.trackingSince ?? startOfMonth(now);
    const vat = vatEnabled ? await vatToSetAside(io, since, now) : 0;

    if (settings.legalStatus === 'company') {
        const rate = settings.provisionRateBp ?? DEFAULT_COMPANY_PROVISION_BP;
        const [revenue, charges, paid] = await Promise.all([
            io.repo.revenueBetween(io.workspaceId, since, now),
            io.repo.chargesBetween(io.workspaceId, since, now),
            io.repo.paidByRoles(io.workspaceId, ['social', 'tax'], since, now)
        ]);
        const contributions = Math.max(0, applyBp(Math.max(0, revenue - charges), rate) - paid);
        const total = contributions + vat;
        return {
            legalStatus: 'company',
            declaration: null,
            setAside: { total, contributions, incomeTax: 0, vat },
            available: balance - total,
            thresholds: null
        };
    }

    const micro = microSettingsOf(settings);
    if (micro === null) return null;
    const current = periodOf(now, micro.period);
    const previous = previousPeriod(current, micro.period);
    const target = declarationTarget(now, micro.period);
    const yearStart = `${now.slice(0, 4)}-01-01`;
    const [inProgress, closed, yearRevenue] = await Promise.all([
        periodFigures(io, micro, current, now),
        periodFigures(io, micro, previous, now),
        io.repo.revenueBetween(io.workspaceId, yearStart, now)
    ]);
    const stillDue = now <= previous.deadline;
    const contributions = inProgress.contributions + (stillDue ? closed.contributions : 0);
    const incomeTax = inProgress.incomeTax + (stillDue ? closed.incomeTax : 0);
    const total = contributions + incomeTax + vat;
    const declared = target.closed ? closed : inProgress;
    const limits = microThresholds(micro.activity, now);
    const pending = (receivables ?? []).reduce((sum, r) => sum + r.remainingCents - r.remainingVatCents, 0);

    return {
        legalStatus: 'micro',
        declaration: {
            label: target.period.label,
            from: target.period.from,
            to: target.period.to,
            deadline: target.period.deadline,
            closed: target.closed,
            revenue: declared.revenue,
            contributions: declared.contributions,
            incomeTax: declared.incomeTax
        },
        setAside: { total, contributions, incomeTax, vat },
        available: balance - total,
        thresholds: {
            year: Number(now.slice(0, 4)),
            revenue: yearRevenue,
            projected: yearRevenue + pending,
            ceiling: limits.ceiling,
            vatBase: vatEnabled ? null : limits.vatBase,
            vatMajor: vatEnabled ? null : limits.vatMajor
        }
    };
}

/**
 * Les versements URSSAF attendus d'ici `horizon`, à leur échéance : celui de la
 * période close s'il n'est pas passé, puis celui de la période en cours, sur ce
 * qu'elle a déjà encaissé. De quoi les faire sortir de la prévision au bon mois.
 */
export async function microPaymentsDue(
    io: StatusIo,
    settings: FinanceStatusSettings,
    now: string,
    horizon: string
): Promise<{ date: string; amount: number }[]> {
    const micro = microSettingsOf(settings);
    if (micro === null) return [];
    const current = periodOf(now, micro.period);
    const previous = previousPeriod(current, micro.period);
    const due: { date: string; amount: number }[] = [];
    for (const period of [previous, current]) {
        if (period.deadline < now || period.deadline > horizon) continue;
        const figures = await periodFigures(io, micro, period, now);
        const amount = figures.contributions + figures.incomeTax;
        if (amount > 0) due.push({ date: period.deadline, amount });
    }
    return due;
}
