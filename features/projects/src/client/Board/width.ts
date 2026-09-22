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
 * Idem pour la barre d'onglets, dont la largeur naturelle est mesurée sur sa
 * rangée fantôme : hors flux et en `max-content`, elle ne dépend pas de la
 * largeur qu'on est en train de décider.
 */
export function tabsNaturalWidth(innerWidth: number): number {
    // Un pixel de jeu : la mesure est arrondie au-dessus, et une barre qui
    // tombe pile resterait repliée pour une fraction de pixel.
    return innerWidth + POPUP_CHROME + 1;
}

/**
 * Ce que la frise réclame : tout ce que la fenêtre accorde. Sa fenêtre de temps
 * se déduit de la place offerte, jamais l'inverse : chaque pixel de plus est une
 * journée de plus sous les yeux, et c'est la lisibilité de l'échelle qui en
 * dépend. Le store écrête à la fenêtre, marges déduites, et rend la largeur à la
 * sortie de l'onglet.
 */
export const TIMELINE_WIDTH_REQUEST = Number.MAX_SAFE_INTEGER;

/**
 * La largeur que `box` ATTEINDRA dans la popup, et non celle qu'elle a. La popup
 * s'élargit par une transition CSS de 400 ms : une frise qui se recalculerait sur
 * la largeur du moment refermerait et rouvrirait sa fenêtre de temps à chaque
 * image, et tout son contenu glisserait sous les yeux pendant la transition.
 * Calculée sur la cible, elle est dessinée juste dès la première image et le
 * cadre ne fait que la découvrir.
 *
 * La cible est le plafond que le store pose en style inline (`stores/popupWidth`),
 * lisible avant que la transition ne l'ait atteint, borné par les marges du cadre
 * quand la fenêtre est plus étroite que lui, et diminué de l'habillage mesuré
 * entre le cadre et la boîte. Hors d'une popup de feature, la mesure du moment
 * fait foi.
 */
export function popupTargetWidth(box: HTMLElement): number {
    const frame = box.closest<HTMLElement>('[data-popup-frame]');
    const cap = frame ? Number.parseFloat(frame.style.maxWidth) : Number.NaN;
    if (!frame || Number.isNaN(cap)) return box.clientWidth;
    const frameStyle = getComputedStyle(frame);
    const room = window.innerWidth - Number.parseFloat(frameStyle.left) - Number.parseFloat(frameStyle.right);
    const chrome = frame.clientWidth - box.clientWidth;
    // Jamais moins que la place déjà offerte : pendant un rétrécissement, la
    // boîte est encore large et c'est elle qui dit ce qu'il faut dessiner.
    return Math.max(Math.min(cap, room) - chrome, box.clientWidth);
}
