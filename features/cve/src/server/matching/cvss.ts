import type { CveSeverity } from '../../contracts/domain';

/**
 * La note de base CVSS 3.x d'un vecteur, quand un avis n'a pas de gravité en
 * toutes lettres (RustSec, PyPA, Go vulndb n'en écrivent pas, mais donnent le
 * vecteur). Les formules sont celles de la spécification 3.1 ; un vecteur
 * incomplet, ou d'une autre version, rend `null`.
 */

const WEIGHTS = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    CIA: { H: 0.56, L: 0.22, N: 0 }
} as const;

/** L'arrondi au dixième supérieur de la spécification, à l'abri des erreurs de virgule flottante. */
function roundUp(value: number): number {
    const int = Math.round(value * 100000);
    return int % 10000 === 0 ? int / 100000 : (Math.floor(int / 10000) + 1) / 10;
}

export function cvss3Score(vector: string): number | null {
    if (!/^CVSS:3\.[01]\//.test(vector)) return null;
    const metrics = new Map(
        vector
            .split('/')
            .slice(1)
            .map((part) => part.split(':') as [string, string])
    );
    const pick = <T extends Record<string, number>>(table: T, key: string): number | null => {
        const value = metrics.get(key);
        return value !== undefined && value in table ? table[value as keyof T] : null;
    };
    const changed = metrics.get('S') === 'C';
    const av = pick(WEIGHTS.AV, 'AV');
    const ac = pick(WEIGHTS.AC, 'AC');
    const ui = pick(WEIGHTS.UI, 'UI');
    const pr = pick(changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 }, 'PR');
    const c = pick(WEIGHTS.CIA, 'C');
    const i = pick(WEIGHTS.CIA, 'I');
    const a = pick(WEIGHTS.CIA, 'A');
    if ([av, ac, ui, pr, c, i, a].some((v) => v === null) || !metrics.has('S')) return null;

    const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
    const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
    if (impact <= 0) return 0;
    const exploitability = 8.22 * av! * ac! * pr! * ui!;
    return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

/** La gravité qualitative d'une note, selon les seuils de la spécification. */
export function severityOfScore(score: number): CveSeverity {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    if (score > 0) return 'low';
    return 'none';
}
