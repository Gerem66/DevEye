/**
 * L'identité d'un dossier, dans son propre module : les visuels de tuiles et
 * l'écran déployé en ont besoin, et la garder chez l'un des deux fermerait un
 * cycle d'imports.
 */

/** Un dossier n'est pas une vue : sa clé ne sert qu'au morphe et à la présence. */
export const folderKey = (id: string) => `folder:${id}`;

/** Intitulé affiché : un dossier sans nom reste lisible plutôt que muet. */
export const folderTitle = (title: string) => title.trim() || 'Dossier';
