import type { SearchSelectOption } from 'deveye-sdk-client';

/**
 * Une devise telle qu'on la cherche : par son nom, son code, ou le pays où elle
 * a cours. Rien n'est tabulé : le code d'une devise commence par celui de son
 * pays (USD, US), et le navigateur connaît les noms des deux. Une devise que la
 * source ajouterait demain s'afficherait donc sans une ligne de plus.
 */

const CURRENCY_NAMES = new Intl.DisplayNames(['fr'], { type: 'currency' });
const REGION_NAMES = new Intl.DisplayNames(['fr'], { type: 'region' });

const named = (names: Intl.DisplayNames, code: string): string | null => {
    try {
        const name = names.of(code);
        return name && name !== code ? name : null;
    } catch {
        return null;
    }
};

/** Le pays d'une devise. Les codes en X (franc CFA, or) n'en ont pas. */
export function regionOf(currency: string): string | null {
    return currency.startsWith('X') ? null : currency.slice(0, 2);
}

/** Le drapeau d'un pays : ses deux lettres, écrites en symboles indicateurs régionaux. */
export function flagOf(region: string): string {
    return [...region.toUpperCase()]
        .map((letter) => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65))
        .join('');
}

export const currencyName = (code: string): string => named(CURRENCY_NAMES, code) ?? code;

export function currencyOption(code: string): SearchSelectOption {
    const region = regionOf(code);
    const country = region ? named(REGION_NAMES, region) : null;
    return {
        value: code,
        label: currencyName(code),
        detail: code,
        prefix: region && country ? flagOf(region) : undefined,
        keywords: country ? [country] : []
    };
}
