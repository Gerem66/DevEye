/**
 * La largeur que le kanban réclame de la popup.
 *
 * Calculée et non mesurée, à dessein. Mesurer le `scrollWidth` du tableau
 * reviendrait à lire une géométrie qui dépend de la largeur qu'on est en train
 * de décider : la popup grandit, le tableau grandit, la mesure repart — une
 * boucle qu'il faudrait ensuite amortir. Les colonnes ayant une largeur fixe
 * (`.column { flex: 0 0 288px }`, `.addColumn { flex: 0 0 160px }`), le calcul
 * est exact et stable.
 *
 * ⚠️ Ces trois constantes doublent le CSS. Elles sont voisines du fichier qui
 * les porte, et un écart ne produit qu'une popup un peu large ou un peu
 * étroite — jamais une mise en page cassée : le tableau défile dans sa propre
 * boîte, quoi qu'il arrive.
 */

const COLUMN_WIDTH = 288;
const ADD_COLUMN_WIDTH = 160;
/** `--space-md`, le `gap` du tableau. */
const GAP = 16;

/**
 * Le chrome horizontal de la popup autour du contenu : deux fois le padding du
 * corps, plus la gouttière de la barre de défilement et les bordures.
 */
const POPUP_CHROME = 2 * 16 + 12;

export function boardNaturalWidth(columnCount: number, canWrite: boolean): number {
    const tiles = columnCount + (canWrite ? 1 : 0);
    if (tiles === 0) return 0;
    const content = columnCount * COLUMN_WIDTH + (canWrite ? ADD_COLUMN_WIDTH : 0) + Math.max(0, tiles - 1) * GAP;
    return content + POPUP_CHROME;
}

/**
 * Idem pour la frise, dont la largeur de contenu est déjà connue : elle découle
 * de la fenêtre de dates et du zoom (voir `Timeline/scale.ts`).
 */
export function timelineNaturalWidth(innerWidth: number): number {
    return innerWidth + POPUP_CHROME;
}
