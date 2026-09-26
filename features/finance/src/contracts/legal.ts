/**
 * Ce que la loi française fixe pour une micro-entreprise, daté : un taux change
 * au 1er janvier (parfois au 1er juillet), et une période passée se calcule au
 * taux de son époque. Tout est en points de base (1 % = 100) et en centimes.
 * Ce sont des estimations affichées comme telles : la déclaration fait foi.
 *
 * À relire à chaque loi de finances. Sources :
 *  - cotisations : service-public.gouv.fr (actualité A18823, BNC à 25,6 % au
 *    1er janvier 2026), urssaf.fr (évolution des taux des auto-entrepreneurs) ;
 *  - formation professionnelle : entreprises.gouv.fr (FAQ « taux de
 *    contribution à la formation »), bpifrance-creation.fr ;
 *  - plafonds et franchise de TVA : autoentrepreneur.urssaf.fr (« 2026 :
 *    modification des seuils »), impots.gouv.fr.
 */

/** L'activité déclarée : elle fixe le taux, la formation professionnelle et le plafond. */
export type MicroActivity = 'bnc' | 'bnc_cipav' | 'bic_services' | 'bic_sales';

export const MICRO_ACTIVITIES: { id: MicroActivity; label: string; hint: string }[] = [
    { id: 'bnc', label: 'Libéral', hint: 'Profession libérale au régime général (BNC) : la plupart des développeurs.' },
    { id: 'bnc_cipav', label: 'Libéral CIPAV', hint: 'Profession libérale dont la retraite relève de la CIPAV.' },
    { id: 'bic_services', label: 'Services', hint: 'Prestation de services commerciale ou artisanale (BIC).' },
    { id: 'bic_sales', label: 'Vente', hint: 'Vente de marchandises (BIC).' }
];

interface RateRow {
    /** Premier jour de validité, `AAAA-MM-JJ`. */
    from: string;
    /** Cotisations sociales, en points de base du chiffre d'affaires. */
    social: Record<MicroActivity, number>;
}

/** Du plus ancien au plus récent. Une date antérieure au premier prend le premier. */
const RATES: RateRow[] = [
    { from: '2024-07-01', social: { bnc: 2_310, bnc_cipav: 2_320, bic_services: 2_120, bic_sales: 1_230 } },
    { from: '2025-01-01', social: { bnc: 2_460, bnc_cipav: 2_320, bic_services: 2_120, bic_sales: 1_230 } },
    { from: '2026-01-01', social: { bnc: 2_560, bnc_cipav: 2_320, bic_services: 2_120, bic_sales: 1_230 } }
];

/** Contribution à la formation professionnelle : commerçant 0,1 %, libéral et prestataire 0,2 %. */
const TRAINING_BP: Record<MicroActivity, number> = { bnc: 20, bnc_cipav: 20, bic_services: 20, bic_sales: 10 };

/** Versement libératoire de l'impôt sur le revenu, payé avec les cotisations quand on l'a choisi. */
const INCOME_TAX_BP: Record<MicroActivity, number> = { bnc: 220, bnc_cipav: 220, bic_services: 170, bic_sales: 100 };

interface ThresholdRow {
    from: string;
    /** Plafond du régime micro, services puis vente. */
    ceiling: { services: number; sales: number };
    /** Franchise en base de TVA : le seuil, puis le seuil majoré qui la fait perdre aussitôt. */
    vat: { services: { base: number; major: number }; sales: { base: number; major: number } };
}

const THRESHOLDS: ThresholdRow[] = [
    {
        from: '2024-01-01',
        ceiling: { services: 7_770_000, sales: 18_870_000 },
        vat: { services: { base: 3_680_000, major: 3_910_000 }, sales: { base: 9_190_000, major: 10_100_000 } }
    },
    {
        from: '2025-01-01',
        ceiling: { services: 7_770_000, sales: 18_870_000 },
        vat: { services: { base: 3_750_000, major: 4_125_000 }, sales: { base: 8_500_000, major: 9_350_000 } }
    },
    {
        from: '2026-01-01',
        ceiling: { services: 8_360_000, sales: 20_310_000 },
        vat: { services: { base: 3_750_000, major: 4_125_000 }, sales: { base: 8_500_000, major: 9_350_000 } }
    }
];

function rowAt<T extends { from: string }>(rows: readonly T[], date: string): T {
    let found = rows[0];
    for (const row of rows) if (row.from <= date) found = row;
    return found;
}

/**
 * Ce qu'une micro-entreprise verse sur son chiffre d'affaires à une date, en
 * points de base : cotisations (ou le taux choisi à la place, l'ACRE par
 * exemple), formation professionnelle, et versement libératoire s'il est choisi.
 */
export function microRates(
    activity: MicroActivity,
    date: string,
    options: { socialOverrideBp: number | null; incomeTaxPrepaid: boolean }
): { socialBp: number; incomeTaxBp: number } {
    const social = options.socialOverrideBp ?? rowAt(RATES, date).social[activity];
    return {
        socialBp: social + TRAINING_BP[activity],
        incomeTaxBp: options.incomeTaxPrepaid ? INCOME_TAX_BP[activity] : 0
    };
}

/** Le taux légal des cotisations seules, pour dire ce que remplace un taux choisi. */
export function legalSocialBp(activity: MicroActivity, date: string): number {
    return rowAt(RATES, date).social[activity];
}

/** Les seuils d'une année civile, pour cette activité. */
export function microThresholds(
    activity: MicroActivity,
    date: string
): { ceiling: number; vatBase: number; vatMajor: number } {
    const row = rowAt(THRESHOLDS, date);
    const kind = activity === 'bic_sales' ? 'sales' : 'services';
    return { ceiling: row.ceiling[kind], vatBase: row.vat[kind].base, vatMajor: row.vat[kind].major };
}

/** Le montant d'un taux sur une base, arrondi au centime le plus proche. */
export function applyBp(amountCents: number, bp: number): number {
    return Math.round((amountCents * bp) / 10_000);
}

export type DeclarationPeriod = 'monthly' | 'quarterly';

const MONTHS = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre'
];

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function lastDayOf(year: number, month: number): string {
    return `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

export interface Period {
    /** `2026-09` ou `2026-T3` : la clé d'une déclaration. */
    key: string;
    label: string;
    from: string;
    to: string;
    /** Le dernier jour pour déclarer et payer : la fin du mois qui suit la période. */
    deadline: string;
}

/** La période de déclaration qui contient ce jour. */
export function periodOf(date: string, period: DeclarationPeriod): Period {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const first = period === 'monthly' ? month : Math.floor((month - 1) / 3) * 3 + 1;
    const last = period === 'monthly' ? month : first + 2;
    const next = last === 12 ? { year: year + 1, month: 1 } : { year, month: last + 1 };
    const quarter = (first - 1) / 3 + 1;
    return {
        key: period === 'monthly' ? `${year}-${pad2(month)}` : `${year}-T${quarter}`,
        label:
            period === 'monthly'
                ? `${MONTHS[month - 1]} ${year}`
                : `${quarter === 1 ? '1er' : `${quarter}e`} trimestre ${year}`,
        from: `${year}-${pad2(first)}-01`,
        to: lastDayOf(year, last),
        deadline: lastDayOf(next.year, next.month)
    };
}

/** La période d'avant. */
export function previousPeriod(current: Period, period: DeclarationPeriod): Period {
    const year = Number(current.from.slice(0, 4));
    const month = Number(current.from.slice(5, 7));
    const back = period === 'monthly' ? 1 : 3;
    const total = year * 12 + (month - 1) - back;
    return periodOf(`${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-01`, period);
}
