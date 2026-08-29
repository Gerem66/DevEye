/**
 * La règle de comparaison de deux lieux, isolée du rendu : où nos chemins se
 * séparent-ils ? Quel nœud s'entoure en découle entièrement.
 */

/**
 * Le segment du chemin d'un pair à signaler sur mon écran, ou `null`.
 *
 * | Situation | Résultat |
 * |---|---|
 * | il prolonge mon chemin | le segment juste sous moi |
 * | il est dans un nœud voisin du mien | ce nœud-là |
 * | nos chemins sont identiques | `null`, on se voit par les curseurs |
 * | il est en amont de moi | `null`, rien à désigner |
 *
 * Le cas « nœud voisin » est indispensable : une feature qui sélectionne d'office
 * son premier élément place toujours ses visiteurs dedans, jamais au niveau
 * au-dessus, seule position où « son chemin commence par le mien » s'appliquerait.
 */
export function divergingSegment(mine: readonly string[], peer: readonly string[]): string | null {
    let depth = 0;
    while (depth < mine.length && depth < peer.length && peer[depth] === mine[depth]) depth += 1;
    // Il est au même endroit que moi, ou en amont.
    if (depth >= peer.length) return null;
    return peer[depth];
}
