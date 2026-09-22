import type { InvoicingIssuer } from './domain';

/**
 * Ce que la loi exige de l'émetteur avant qu'un document puisse sortir. Sans
 * dénomination, le document n'est même pas lisible ; sans SIRET, il n'est pas
 * conforme en France. Une seule règle, lue par le serveur qui refuse d'émettre
 * et par l'écran qui prévient avant : ils ne peuvent pas se contredire.
 *
 * Rend ce qui manque, dans les mots d'une phrase (« la dénomination », « le
 * SIRET »), ou rien quand tout y est.
 */
export function issuerGaps(issuer: InvoicingIssuer): string[] {
    const gaps: string[] = [];
    if (issuer.legalName.trim().length === 0) gaps.push('la dénomination');
    if (issuer.country.trim().toLowerCase() === 'france' && issuer.siret.trim().length === 0) gaps.push('le SIRET');
    return gaps;
}

/** « la dénomination et le SIRET », prêt à entrer dans une phrase. */
export function listGaps(gaps: readonly string[]): string {
    if (gaps.length <= 1) return gaps[0] ?? '';
    return `${gaps.slice(0, -1).join(', ')} et ${gaps[gaps.length - 1]}`;
}
