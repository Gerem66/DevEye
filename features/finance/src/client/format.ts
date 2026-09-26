import type {
    FinanceAccountKind,
    FinanceCategoryRole,
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

export const ACCOUNT_KINDS: { id: FinanceAccountKind; label: string; icon: string; hint: string }[] = [
    {
        id: 'checking',
        label: 'Courant',
        icon: 'finance',
        hint: 'Le compte où arrivent les règlements et d’où partent les dépenses.'
    },
    {
        id: 'savings',
        label: 'Épargne',
        icon: 'star',
        hint: 'Là où l’on range ses provisions : compté à part du disponible.'
    },
    { id: 'cash', label: 'Caisse', icon: 'key', hint: 'Les espèces encaissées ou avancées.' },
    { id: 'other', label: 'Autre', icon: 'other', hint: 'Tout ce qui ne rentre pas ailleurs.' }
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

export const RANGES: { id: FinanceRange; label: string }[] = [
    { id: 'month', label: 'Ce mois' },
    { id: 'quarter', label: 'Ce trimestre' },
    { id: 'year', label: 'Cette année' }
];

/** Le nom d'une couleur, pour qui ne la voit pas. */
export const COLOR_LABELS: Record<FinanceColor, string> = {
    red: 'Rouge',
    orange: 'Orange',
    yellow: 'Jaune',
    green: 'Vert',
    blue: 'Bleu',
    indigo: 'Indigo',
    purple: 'Violet',
    pink: 'Rose'
};

/**
 * Choisies dans `icons.css`, sans en ajouter : une catégorie doit être
 * reconnaissable, la couleur fait l'essentiel. Le libellé dit le dessin.
 */
export const CATEGORY_ICONS: { id: string; label: string }[] = [
    { id: 'other', label: 'Point' },
    { id: 'home', label: 'Maison' },
    { id: 'finance', label: 'Billet' },
    { id: 'key', label: 'Clé' },
    { id: 'star', label: 'Étoile' },
    { id: 'cloud', label: 'Nuage' },
    { id: 'activity', label: 'Courbe' },
    { id: 'server', label: 'Serveur' },
    { id: 'mail', label: 'Enveloppe' },
    { id: 'users', label: 'Personnes' },
    { id: 'clock', label: 'Horloge' },
    { id: 'file', label: 'Document' },
    { id: 'rocket', label: 'Fusée' },
    { id: 'shield', label: 'Bouclier' },
    { id: 'projects', label: 'Tableau' },
    { id: 'notes', label: 'Carnet' },
    { id: 'refresh', label: 'Flèches' }
];

/** Proposé en un bouton à qui n'a aucune catégorie, jamais créé d'office. */
export const DEFAULT_CATEGORIES: {
    name: string;
    flow: 'expense' | 'income';
    color: FinanceColor;
    icon: string;
    role: FinanceCategoryRole | null;
}[] = [
    { name: 'Prestations', flow: 'income', color: 'green', icon: 'server', role: null },
    { name: 'Ventes', flow: 'income', color: 'indigo', icon: 'activity', role: null },
    { name: 'Remboursements', flow: 'income', color: 'purple', icon: 'refresh', role: 'other' },
    { name: 'Hébergement et infra', flow: 'expense', color: 'blue', icon: 'cloud', role: null },
    { name: 'Logiciels et abonnements', flow: 'expense', color: 'purple', icon: 'clock', role: null },
    { name: 'Matériel', flow: 'expense', color: 'indigo', icon: 'server', role: null },
    { name: 'Téléphone et internet', flow: 'expense', color: 'blue', icon: 'activity', role: null },
    { name: 'Déplacements', flow: 'expense', color: 'orange', icon: 'rocket', role: null },
    { name: 'Repas d’affaires', flow: 'expense', color: 'pink', icon: 'users', role: null },
    { name: 'Formation', flow: 'expense', color: 'green', icon: 'notes', role: null },
    { name: 'Honoraires', flow: 'expense', color: 'yellow', icon: 'file', role: null },
    { name: 'Assurances', flow: 'expense', color: 'indigo', icon: 'shield', role: null },
    { name: 'Frais bancaires', flow: 'expense', color: 'red', icon: 'finance', role: null },
    { name: 'Cotisations sociales', flow: 'expense', color: 'orange', icon: 'shield', role: 'social' },
    { name: 'TVA reversée', flow: 'expense', color: 'purple', icon: 'file', role: 'vat' },
    { name: 'Impôts', flow: 'expense', color: 'red', icon: 'file', role: 'tax' }
];

/** Ce que dit le rôle d'une catégorie, en un mot, pour la rangée qui la montre. */
export const CATEGORY_ROLE_LABELS: Record<FinanceCategoryRole, string> = {
    other: 'hors chiffre d’affaires',
    social: 'verse des cotisations',
    tax: 'verse des impôts',
    vat: 'reverse la TVA'
};
