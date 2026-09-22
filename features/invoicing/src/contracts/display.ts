import type { DocumentKind, LineUnit } from './domain';

/**
 * La mise en forme, partagée par l'écran et par le papier : un même montant
 * doit s'écrire pareil dans l'application et sur la facture imprimée. C'est
 * aussi la raison pour laquelle rien ici ne dépend du navigateur.
 */

/** `Intl` place le symbole et l'espace insécable ; la division par cent est la dernière étape. */
export function formatMoney(cents: number, currency: string, options?: { compact?: boolean }): string {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency,
        // Une facture montre ses centimes : les arrondir ferait que la somme
        // des lignes ne retombe pas sur le total imprimé.
        minimumFractionDigits: options?.compact ? 0 : 2,
        maximumFractionDigits: options?.compact ? 0 : 2,
        notation: options?.compact ? 'compact' : 'standard'
    }).format(cents / 100);
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
    if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
}

/** L'inverse, pour remplir un champ depuis une valeur existante. */
export function amountToInput(cents: number): string {
    return (cents / 100).toFixed(2).replace('.', ',');
}

/** Le jour courant, au format `AAAA-MM-JJ` attendu par le serveur. */
export function todayIso(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Une quantité tapée à la main, en millièmes d'unité, ou `null`. */
export function parseQuantity(value: string): number | null {
    const cleaned = value.replace(/\s/g, '').replace(',', '.');
    if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 1000);
}

/** L'inverse, sans les zéros qui ne disent rien : 1500 s'écrit « 1,5 ». */
export function quantityToInput(milli: number): string {
    const written = (milli / 1000).toFixed(3).replace(/\.?0+$/, '');
    return written.length === 0 ? '0' : written.replace('.', ',');
}

/** Un taux en points de base, tel qu'il s'imprime : `550` devient « 5,5 % ». */
export function formatVatRate(bp: number): string {
    return `${(bp / 100).toFixed(1).replace(/\.0$/, '').replace('.', ',')} %`;
}

const UNITS: Record<LineUnit, { one: string; many: string }> = {
    hour: { one: 'heure', many: 'heures' },
    day: { one: 'jour', many: 'jours' },
    unit: { one: 'unité', many: 'unités' },
    month: { one: 'mois', many: 'mois' },
    fixed: { one: 'forfait', many: 'forfaits' }
};

export function unitLabel(unit: LineUnit, quantityMilli = 1000): string {
    const entry = UNITS[unit];
    return quantityMilli > 1000 ? entry.many : entry.one;
}

export const UNIT_OPTIONS = (Object.keys(UNITS) as LineUnit[]).map((unit) => ({
    value: unit,
    label: UNITS[unit].many
}));

const KINDS: Record<DocumentKind, { label: string; plural: string; icon: string }> = {
    quote: { label: 'Devis', plural: 'Devis', icon: 'file' },
    invoice: { label: 'Facture', plural: 'Factures', icon: 'invoicing' },
    credit: { label: 'Avoir', plural: 'Avoirs', icon: 'move-to-left' }
};

export function kindLabel(kind: DocumentKind): string {
    return KINDS[kind].label;
}

export function kindIcon(kind: DocumentKind): string {
    return KINDS[kind].icon;
}

export function formatDate(iso: string): string {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

export function formatDateShort(iso: string): string {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}
