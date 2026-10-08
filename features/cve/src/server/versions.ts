/**
 * La comparaison de versions des produits que le NVD nomme : des nombres
 * séparés par des points, parfois suivis d'un suffixe (`1.25.3`, `20.11.1`,
 * `8.0.36`, `3.0.0-rc1`). Pas de semver strict : le NVD écrit les versions
 * comme chaque éditeur, et une comparaison qui exigerait trois nombres en
 * raterait la moitié.
 */

/** Le produit tel qu'une ligne de `ft_cve_products` le décrit. */
export interface AffectedRange {
    version: string | null;
    start_incl: string | null;
    start_excl: string | null;
    end_incl: string | null;
    end_excl: string | null;
}

function parse(version: string): { numbers: number[]; pre: boolean } {
    const head = /^\d+(?:\.\d+)*/.exec(version.trim())?.[0] ?? '';
    const rest = version.trim().slice(head.length);
    return {
        numbers: head ? head.split('.').map(Number) : [],
        // `3.0.0-rc1` vient avant `3.0.0` ; `1.2.3+build` ne s'en distingue pas.
        pre: /^[-.~]?[a-z]/i.test(rest)
    };
}

/** Négatif, nul ou positif, comme un comparateur de tri. */
export function compareVersions(a: string, b: string): number {
    const x = parse(a);
    const y = parse(b);
    const length = Math.max(x.numbers.length, y.numbers.length);
    for (let i = 0; i < length; i++) {
        const diff = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return Number(y.pre) - Number(x.pre);
}

/**
 * Cette version tombe-t-elle dans ce que la ligne décrit ? Une ligne sans
 * version ni borne dit « toutes les versions » : sur un produit suivi depuis
 * des années, elle ferait de chaque version une victime, et ne compte pas.
 */
export function isAffected(version: string, range: AffectedRange): boolean {
    if (!/^\d/.test(version)) return false;
    if (range.version !== null) return compareVersions(version, range.version) === 0;
    const bounded = range.start_incl ?? range.start_excl ?? range.end_incl ?? range.end_excl;
    if (bounded === null) return false;
    if (range.start_incl !== null && compareVersions(version, range.start_incl) < 0) return false;
    if (range.start_excl !== null && compareVersions(version, range.start_excl) <= 0) return false;
    if (range.end_incl !== null && compareVersions(version, range.end_incl) > 0) return false;
    if (range.end_excl !== null && compareVersions(version, range.end_excl) >= 0) return false;
    return true;
}
