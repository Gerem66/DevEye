/**
 * Ce qu'une trame numérotée devient : appliquée si elle suit la dernière,
 * ignorée si elle est déjà vue, et un trou fait rejoindre la séance.
 */
export function gate(last: number, seq: number): 'apply' | 'stale' | 'gap' {
    if (seq <= last) return 'stale';
    return seq === last + 1 ? 'apply' : 'gap';
}
