/**
 * Manipulation des chemins TELS QUE L'AGENT LES RAPPORTE, donc dans le style de
 * l'appareil distant et pas dans celui du navigateur : un poste Windows renvoie
 * `C:\Users\...`, un poste Unix `/home/...`. Le navigateur n'a aucune notion de
 * l'un ou l'autre, d'où ces deux fonctions plutôt qu'une bibliothèque de chemins.
 *
 * Partagé par l'explorateur du Monitoring et le sélecteur de dossier CloudSync :
 * ils naviguent dans la même arborescence distante, ils doivent la joindre de la
 * même façon.
 */

/** Chemin Windows (racine de lecteur ou partage UNC), tel que l'agent le rend. */
export const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/**
 * Joint un dossier et un nom d'enfant en gardant le séparateur du chemin.
 *
 * Le test porte sur la présence d'un antislash SANS slash : un chemin Windows
 * mixte (`C:/Users\dev`) reste alors joint au slash, ce qui est accepté par
 * Windows, alors que deviner l'inverse casserait tout chemin Unix contenant un
 * antislash — lequel est un caractère de nom parfaitement légal sous Unix.
 */
export function joinPath(base: string, name: string): string {
    if (base.endsWith('/') || base.endsWith('\\')) return base + name;
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return base + sep + name;
}
