import type { LineKind } from './domain';

/**
 * L'arithmétique de la facturation, et le **seul** endroit qui arrondit. Le SQL
 * ne calcule jamais un montant : il ne somme que des colonnes déjà arrondies
 * ici. C'est ce qui permet au client d'afficher un total en direct et au serveur
 * de figer le même à l'émission, sans deux implémentations à tenir d'accord.
 *
 * Tout est en entiers : centimes pour les montants, millièmes pour les
 * quantités, points de base pour les taux.
 */

/** Ce dont un total a besoin, et rien de plus. */
export interface MoneyLine {
    kind: LineKind;
    quantityMilli: number;
    unitPrice: number;
    vatRateBp: number;
}

/** Une tranche du récapitulatif de TVA, mention obligatoire du document. */
export interface VatShare {
    rateBp: number;
    netCents: number;
    vatCents: number;
}

export interface DocumentTotals {
    netCents: number;
    vatCents: number;
    grossCents: number;
    /** Du taux le plus élevé au plus bas, comme se lit un pied de facture. */
    vat: readonly VatShare[];
}

/**
 * Le hors taxe d'une ligne. Arrondi au centime le plus proche, le demi vers le
 * haut : 1,333 h à 75,00 € donne 99,98 € et non 99,97 €.
 */
export function lineNet(line: MoneyLine): number {
    if (line.kind === 'text') return 0;
    return Math.floor((line.unitPrice * line.quantityMilli + 500) / 1000);
}

/**
 * Les totaux d'un document. La TVA se calcule **par taux sur la base agrégée**,
 * jamais ligne par ligne : c'est la pratique française, et c'est ce qui évite le
 * centime d'écart entre le récapitulatif imprimé et le total. Somme des
 * tranches et total de TVA sont donc égaux par construction.
 */
export function documentTotals(lines: readonly MoneyLine[]): DocumentTotals {
    const bases = new Map<number, number>();
    let netCents = 0;

    for (const line of lines) {
        const net = lineNet(line);
        if (line.kind === 'text') continue;
        netCents += net;
        bases.set(line.vatRateBp, (bases.get(line.vatRateBp) ?? 0) + net);
    }

    const vat: VatShare[] = [...bases.entries()]
        .sort(([a], [b]) => b - a)
        .map(([rateBp, base]) => ({
            rateBp,
            netCents: base,
            vatCents: Math.floor((base * rateBp + 5000) / 10_000)
        }));

    const vatCents = vat.reduce((sum, share) => sum + share.vatCents, 0);
    return { netCents, vatCents, grossCents: netCents + vatCents, vat };
}

/**
 * Ce qu'une facture attend encore. Les avoirs émis qui la corrigent comptent
 * comme des règlements : ils éteignent la créance sans qu'un euro circule.
 * Jamais négatif : un trop-perçu est un avoir à faire, pas un reste dû à l'envers.
 */
export function remainingCents(input: {
    grossCents: number;
    paidCents: number;
    creditedCents: number;
    deductedCents: number;
}): number {
    const settled = input.paidCents + input.creditedCents + input.deductedCents;
    return Math.max(0, input.grossCents - settled);
}

/**
 * La part de TVA que porte un encaissement : sa fraction de la taxe de la
 * facture, arrondie au centime le plus proche, le demi vers le haut. Pour une
 * prestation de services, la TVA est due à l'encaissement : c'est ce montant
 * que déclare l'espace, et celui que Finances reprend. En `BigInt` : le produit
 * de deux montants plafonnés dépasse la précision d'un `number`.
 */
export function paymentVatCents(amountCents: number, totalVatCents: number, totalGrossCents: number): number {
    if (totalGrossCents <= 0 || totalVatCents <= 0 || amountCents <= 0) return 0;
    const gross = BigInt(totalGrossCents);
    return Number((BigInt(amountCents) * BigInt(totalVatCents) * 2n + gross) / (2n * gross));
}
