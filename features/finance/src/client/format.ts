import type {
    FinanceAccountKind,
    FinanceBudgetPeriod,
    FinanceColor,
    FinanceFrequency,
    FinanceRange,
    FinanceTransactionKind
} from '../contracts/domain';

/** Mise en forme et vocabulaire : un même montant doit s'écrire pareil partout. */

/** `Intl` place le symbole et l'espace insécable ; la division par cent est la dernière étape. */
export function formatMoney(cents: number, currency: string, options?: { compact?: boolean }): string {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency,
        // Un livre de comptes montre ses centimes: les arrondir ferait que la
        // somme des lignes ne retombe pas sur le total affiché.
        minimumFractionDigits: options?.compact ? 0 : 2,
        maximumFractionDigits: options?.compact ? 0 : 2,
        notation: options?.compact ? 'compact' : 'standard'
    }).format(cents / 100);
}

/** Le même, précédé d'un signe explicite. Pour un solde ou un résultat. */
export function formatSigned(cents: number, currency: string): string {
    const body = formatMoney(Math.abs(cents), currency);
    if (cents === 0) return body;
    // Espace fine insécable (U+202F) entre le signe et le montant, comme le
    // fait `Intl` devant le symbole de devise: en dur, un navigateur pourrait
    // la couper en fin de ligne et laisser un « + » orphelin.
    return `${cents > 0 ? '+' : '\u2212'}\u202f${body}`;
}

/**
 * Un montant tapé à la main, en centimes, ou `null`. Accepte les deux
 * séparateurs décimaux et les espaces de milliers ; arrondi à l'entier le plus
 * proche pour que « 12,999 » ne devienne pas 12,99.
 */
export function parseAmount(value: string): number | null {
    // `\s` couvre déjà l'espace insécable et l'espace fine insécable, que
    // produisent le clavier français et un copier-coller depuis un relevé.
    const cleaned = value.replace(/\s/g, '').replace(',', '.');
    if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
}

/** L'inverse, pour remplir un champ depuis une valeur existante. */
export function amountToInput(cents: number): string {
    return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Les quatre taux français plus l'exonération. Le taux n'est jamais stocké :
 * ces boutons calculent la part de TVA d'un montant TTC.
 */
export const VAT_RATES = [0, 2.1, 5.5, 10, 20] as const;

/** La part de TVA contenue dans un montant TTC, en centimes. */
export function vatFromGross(grossCents: number, rate: number): number {
    if (rate <= 0) return 0;
    return Math.round(grossCents - grossCents / (1 + rate / 100));
}

/** Le taux qu'une part de TVA représente, pour réafficher un choix. */
export function rateOfVat(grossCents: number, vatCents: number): number | null {
    if (grossCents <= 0 || vatCents <= 0) return null;
    const net = grossCents - vatCents;
    if (net <= 0) return null;
    const rate = (vatCents / net) * 100;
    return VAT_RATES.find((candidate) => Math.abs(candidate - rate) < 0.15) ?? null;
}

/** Le jour courant, au format `AAAA-MM-JJ` attendu par le serveur. */
export function todayIso(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `new Date('2026-08-18')` est interprété en UTC puis réaffiché en local, ce
 * qui recule d'un jour à l'ouest de Greenwich : composantes locales explicites.
 */
function localDate(iso: string): Date {
    return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

export function formatDate(iso: string): string {
    return localDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDateShort(iso: string): string {
    return localDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/** L'en-tête d'un groupe de jour dans le journal: « aujourd'hui », sinon la date. */
export function formatDayHeading(iso: string): string {
    const now = todayIso();
    if (iso === now) return "Aujourd'hui";
    const yesterday = shiftDays(now, -1);
    if (iso === yesterday) return 'Hier';
    return localDate(iso).toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: localDate(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    });
}

/** Décale un jour civil, en composantes UTC pour ignorer l'heure d'été. */
export function shiftDays(iso: string, days: number): string {
    const at = new Date(
        Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + days * 86_400_000
    );
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** `AAAA-MM` vers « août 2026 ». */
export function formatMonth(month: string): string {
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString('fr-FR', {
        month: 'long',
        year: 'numeric'
    });
}

/** `AAAA-MM` vers « août », pour un axe où l'année est déjà évidente. */
export function formatMonthShort(month: string): string {
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString('fr-FR', {
        month: 'short'
    });
}

/** « dans 3 jours », « il y a 2 jours », pour une échéance. */
export function formatRelativeDay(iso: string): string {
    const days = Math.round((localDate(iso).getTime() - localDate(todayIso()).getTime()) / 86_400_000);
    if (days === 0) return "aujourd'hui";
    if (days === 1) return 'demain';
    if (days === -1) return 'hier';
    if (days > 0) return `dans ${days} jours`;
    return `il y a ${-days} jours`;
}

export const ACCOUNT_KINDS: { id: FinanceAccountKind; label: string; icon: string }[] = [
    { id: 'checking', label: 'Compte courant', icon: 'finance' },
    { id: 'savings', label: 'Épargne', icon: 'star' },
    { id: 'cash', label: 'Espèces', icon: 'key' },
    { id: 'card', label: 'Carte de crédit', icon: 'square-check' },
    { id: 'business', label: 'Compte professionnel', icon: 'server' },
    { id: 'other', label: 'Autre', icon: 'other' }
];

export function accountKindLabel(kind: FinanceAccountKind): string {
    return ACCOUNT_KINDS.find((k) => k.id === kind)?.label ?? 'Autre';
}

export function accountKindIcon(kind: FinanceAccountKind): string {
    return ACCOUNT_KINDS.find((k) => k.id === kind)?.icon ?? 'other';
}

export const TRANSACTION_KINDS: { id: FinanceTransactionKind; label: string }[] = [
    { id: 'expense', label: 'Dépense' },
    { id: 'income', label: 'Recette' },
    { id: 'transfer', label: 'Virement' }
];

export function transactionKindLabel(kind: FinanceTransactionKind): string {
    return TRANSACTION_KINDS.find((k) => k.id === kind)?.label ?? '';
}

export const FREQUENCIES: { id: FinanceFrequency; label: string; every: string }[] = [
    { id: 'weekly', label: 'Hebdomadaire', every: 'semaines' },
    { id: 'monthly', label: 'Mensuelle', every: 'mois' },
    { id: 'quarterly', label: 'Trimestrielle', every: 'trimestres' },
    { id: 'yearly', label: 'Annuelle', every: 'ans' }
];

/** « tous les mois », « tous les 2 mois ». */
export function frequencyLabel(frequency: FinanceFrequency, interval: number): string {
    const found = FREQUENCIES.find((f) => f.id === frequency);
    if (!found) return '';
    if (interval === 1) {
        return frequency === 'weekly'
            ? 'toutes les semaines'
            : frequency === 'monthly'
              ? 'tous les mois'
              : frequency === 'quarterly'
                ? 'tous les trimestres'
                : 'tous les ans';
    }
    return `tous les ${interval} ${found.every}`;
}

export const BUDGET_PERIODS: { id: FinanceBudgetPeriod; label: string; short: string }[] = [
    { id: 'monthly', label: 'Par mois', short: 'mois' },
    { id: 'quarterly', label: 'Par trimestre', short: 'trimestre' },
    { id: 'yearly', label: 'Par an', short: 'an' }
];

export function budgetPeriodShort(period: FinanceBudgetPeriod): string {
    return BUDGET_PERIODS.find((p) => p.id === period)?.short ?? '';
}

export const RANGES: { id: FinanceRange; label: string }[] = [
    { id: 'month', label: 'Ce mois' },
    { id: 'quarter', label: 'Ce trimestre' },
    { id: 'year', label: 'Cette année' }
];

/** Choisies dans `icons.css`, sans en ajouter : une catégorie doit être reconnaissable, la couleur fait l'essentiel. */
export const CATEGORY_ICONS = [
    'other',
    'home',
    'finance',
    'key',
    'star',
    'cloud',
    'activity',
    'server',
    'mail',
    'users',
    'clock',
    'file',
    'rocket',
    'shield',
    'projects',
    'notes',
    'refresh'
];

/** Proposé en un bouton à qui n'a aucune catégorie, jamais créé d'office. */
export const DEFAULT_CATEGORIES: {
    name: string;
    flow: 'expense' | 'income';
    color: FinanceColor;
    icon: string;
}[] = [
    { name: 'Logement', flow: 'expense', color: 'blue', icon: 'home' },
    { name: 'Courses', flow: 'expense', color: 'green', icon: 'other' },
    { name: 'Transport', flow: 'expense', color: 'indigo', icon: 'rocket' },
    { name: 'Abonnements', flow: 'expense', color: 'purple', icon: 'clock' },
    { name: 'Santé', flow: 'expense', color: 'red', icon: 'shield' },
    { name: 'Loisirs', flow: 'expense', color: 'pink', icon: 'star' },
    { name: 'Restaurants', flow: 'expense', color: 'orange', icon: 'users' },
    { name: 'Impôts et taxes', flow: 'expense', color: 'yellow', icon: 'file' },
    { name: 'Frais bancaires', flow: 'expense', color: 'red', icon: 'finance' },
    { name: 'Fournitures', flow: 'expense', color: 'blue', icon: 'projects' },
    { name: 'Salaire', flow: 'income', color: 'green', icon: 'finance' },
    { name: 'Ventes', flow: 'income', color: 'indigo', icon: 'activity' },
    { name: 'Prestations', flow: 'income', color: 'blue', icon: 'server' },
    { name: 'Remboursements', flow: 'income', color: 'purple', icon: 'refresh' }
];
