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

/**
 * Une entreprise individuelle (EI, micro-entreprise) n'a pas de capital : la
 * forme se lit sans accents ni casse, parce qu'elle est saisie librement.
 */
export function isIndividualForm(legalForm: string): boolean {
    const form = legalForm
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    return /^(ei|eirl|entrepreneur individuel|entreprise individuelle|(micro|auto)[- ]?entrepr)/.test(form);
}

/**
 * « SASU au capital de 1 000 € », ou la forme seule. Le capital ne paraît que
 * pour une société, et jamais nul : une société en a toujours un, et « au
 * capital de 0 » ne se lit que sur une forme qui n'en a pas.
 */
export function legalFormLine(issuer: Pick<InvoicingIssuer, 'legalForm' | 'capital'>): string {
    const form = issuer.legalForm.trim();
    const capital = issuer.capital.trim();
    if (capital.length === 0 || !/[1-9]/.test(capital) || isIndividualForm(form)) return form;
    return form.length === 0 ? `Capital de ${capital}` : `${form} au capital de ${capital}`;
}
