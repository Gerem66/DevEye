/**
 * Manipulation des chemins tels que l'agent les rapporte, donc dans le style de
 * l'appareil distant et non du navigateur : un poste Windows renvoie
 * `C:\Users\...`, un poste Unix `/home/...`. Le navigateur n'a aucune notion de
 * l'un ou l'autre, d'où ces deux fonctions plutôt qu'une bibliothèque de chemins.
 */

/** Chemin Windows (racine de lecteur ou partage UNC), tel que l'agent le rend. */
export const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/**
 * Joint un dossier et un nom d'enfant en gardant le séparateur du chemin. Le test
 * porte sur un antislash sans slash : un chemin Windows mixte (`C:/Users\dev`)
 * reste joint au slash, que Windows accepte, alors que deviner l'inverse casserait
 * tout chemin Unix contenant un antislash, caractère de nom légal là-bas.
 */
export function joinPath(base: string, name: string): string {
    if (base.endsWith('/') || base.endsWith('\\')) return base + name;
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return base + sep + name;
}
