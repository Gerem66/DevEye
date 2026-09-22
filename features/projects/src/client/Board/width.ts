/**
 * Le chrome horizontal de la popup autour du contenu : deux fois le padding du
 * corps, plus la gouttière de la barre de défilement et les bordures.
 */
const POPUP_CHROME = 2 * 16 + 12;

/**
 * La largeur que le kanban réclame de la popup, d'après celle de ses colonnes,
 * mesurée. Les colonnes ne s'étirent ni ne se tassent et ne passent jamais à la
 * ligne : leur étendue ne dépend pas de la largeur qu'on est en train de décider,
 * la mesure ne peut donc pas boucler sur sa réponse.
 */
export function boardNaturalWidth(columnsWidth: number): number {
    return columnsWidth + POPUP_CHROME;
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
