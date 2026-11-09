/**
 * « 1-3, 7, 10- » : les numéros de pages (base 1, bornes comprises), dans
 * l'ordre écrit et sans doublon, en indices de base 0. `null` quand la saisie
 * ne se lit pas ou sort du document. Une borne absente va jusqu'au bout.
 */
export function parseRanges(text: string, count: number): number[] | null {
    const seen = new Set<number>();
    const out: number[] = [];
    const push = (n: number): boolean => {
        if (n < 0 || n >= count) return false;
        if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
        }
        return true;
    };
    for (const raw of text.split(/[,;\s]+/)) {
        const item = raw.trim();
        if (item === '') continue;
        const match = /^(\d*)(?:(-)(\d*))?$/.exec(item);
        if (!match || (match[1] === '' && match[3] === undefined)) return null;
        if (match[2] === undefined) {
            if (!push(Number(match[1]) - 1)) return null;
            continue;
        }
        if (match[1] === '' && match[3] === '') return null;
        const from = match[1] === '' ? 1 : Number(match[1]);
        const to = match[3] === '' ? count : Number(match[3]);
        if (from < 1 || to < 1 || from > count || to > count) return null;
        const step = from <= to ? 1 : -1;
        for (let n = from; step > 0 ? n <= to : n >= to; n += step) push(n - 1);
    }
    return out.length > 0 ? out : null;
}

/** Les indices (base 0) en plages lisibles : « 1-3, 7, 10-12 ». */
export function formatRanges(indices: readonly number[]): string {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        parts.push(j === i ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
        i = j + 1;
    }
    return parts.join(', ');
}
