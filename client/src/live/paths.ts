/**
 * La règle de comparaison de deux lieux, isolée du rendu.
 *
 * Elle tient en une question : **où nos chemins se séparent-ils ?** Tout le
 * comportement visible en découle — quel nœud s'entoure, et lequel ne s'entoure
 * pas. La sortir du hook la rend lisible d'un coup d'œil et vérifiable
 * directement, ce qui compte pour une règle dont chaque cas a une conséquence à
 * l'écran.
 */

/**
 * Le segment du chemin d'un pair à signaler sur mon écran, ou `null`.
 *
 * | Situation | Résultat |
 * |---|---|
 * | il prolonge mon chemin | le segment juste sous moi |
 * | il est dans un nœud voisin du mien | ce nœud-là |
 * | nos chemins sont identiques | `null` — on se voit par les curseurs |
 * | il est en amont de moi | `null` — il est derrière moi, rien à désigner |
 *
 * Le cas « nœud voisin » n'est pas un raffinement : sans lui, un dossier de mail
 * ne se surlignait jamais. Ouvrir une boîte sélectionne d'office la boîte de
 * réception, donc on est toujours déjà **dans** un dossier — jamais au niveau
 * au-dessus, seule position où la règle « son chemin commence par le mien »
 * aurait pu s'appliquer. Même chose pour Monitoring, qui sélectionne d'office le
 * premier appareil.
 */
export function divergingSegment(mine: readonly string[], peer: readonly string[]): string | null {
    let depth = 0;
    while (depth < mine.length && depth < peer.length && peer[depth] === mine[depth]) depth += 1;
    // Il est au même endroit que moi, ou en amont.
    if (depth >= peer.length) return null;
    return peer[depth];
}
