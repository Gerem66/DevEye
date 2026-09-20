/**
 * La largeur que le kanban réclame de la popup, calculée et non mesurée : lire le
 * `scrollWidth` du tableau reviendrait à lire une géométrie qui dépend de la
 * largeur qu'on est en train de décider. Ces constantes doublent le CSS, mais un
 * écart ne donne qu'une popup un peu large ou un peu étroite, le tableau défilant
 * dans sa propre boîte.
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

/**
 * Idem pour la barre d'onglets, dont la largeur naturelle est mesurée sur sa
 * rangée fantôme : hors flux et en `max-content`, elle ne dépend pas de la
 * largeur qu'on est en train de décider.
 */
export function tabsNaturalWidth(innerWidth: number): number {
    // Un pixel de jeu : la mesure est arrondie au-dessus, et une barre qui
    // tombe pile resterait repliée pour une fraction de pixel.
    return innerWidth + POPUP_CHROME + 1;
}
