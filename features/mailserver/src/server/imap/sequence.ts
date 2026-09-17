/** Un ensemble de séquences IMAP : `1:3,7,10:*`. `*` vaut le plus grand numéro existant. */

export interface SequenceRange {
    /** `null` : l'astérisque. */
    from: number | null;
    to: number | null;
}

export function parseSequenceSet(text: string): SequenceRange[] | null {
    if (text === '' || text.length > 8_192) return null;
    const ranges: SequenceRange[] = [];
    for (const part of text.split(',')) {
        const m = /^(\d+|\*)(?::(\d+|\*))?$/.exec(part);
        if (!m) return null;
        const from = m[1] === '*' ? null : Number(m[1]);
        const to = m[2] === undefined ? from : m[2] === '*' ? null : Number(m[2]);
        if (from === 0 || to === 0) return null;
        ranges.push({ from, to });
    }
    return ranges;
}

/**
 * `n` appartient-il à l'ensemble ? `max` remplace `*`. Une plage se lit dans
 * les deux sens, donc `7:*` contient `max` même quand `max` vaut moins que 7.
 */
export function inSequenceSet(ranges: readonly SequenceRange[], n: number, max: number): boolean {
    for (const range of ranges) {
        const a = range.from ?? max;
        const b = range.to ?? max;
        if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
    }
    return false;
}

/** Des UID triés, rendus sous la forme compacte qu'attendent `COPYUID` et `APPENDUID`. */
export function compactUids(uids: readonly number[]): string {
    const parts: string[] = [];
    let start = -1;
    let last = -1;
    const flush = (): void => {
        if (start !== -1) parts.push(start === last ? String(start) : `${start}:${last}`);
    };
    for (const uid of uids) {
        if (uid === last + 1) {
            last = uid;
            continue;
        }
        flush();
        start = uid;
        last = uid;
    }
    flush();
    return parts.join(',');
}
