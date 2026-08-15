/**
 * L'identité d'un dossier, à part de sa carte et de son écran.
 *
 * Dans son propre module parce que les deux bouts en ont besoin : les visuels
 * de tuiles (`tiles/tileVisual`) et l'écran déployé, qui dépend déjà d'eux. Les
 * laisser chez l'un des deux aurait fermé un cycle d'imports.
 */

/** Un dossier n'est pas une vue : sa clé ne sert qu'au morphe et à la présence. */
export const folderKey = (id: string) => `folder:${id}`;

/** Intitulé affiché : un dossier sans nom reste lisible plutôt que muet. */
export const folderTitle = (title: string) => title.trim() || 'Dossier';
