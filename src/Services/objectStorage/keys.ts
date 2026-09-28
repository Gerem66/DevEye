/** Le dossier de travail d'un module, à la racine de son dossier local. */
export const SPOOL_DIR = '.spool';

/**
 * Une clé est un chemin relatif, le même sur le disque et dans un bucket : pas
 * de `/` en tête, pas de segment vide, `.` ou `..`, pas d'octet nul. Le spool
 * n'en est jamais une.
 */
export function assertObjectKey(key: string): void {
    const segments = key.split('/');
    if (
        key.length === 0 ||
        key.includes('\0') ||
        segments.some((s) => s === '' || s === '.' || s === '..') ||
        segments[0] === SPOOL_DIR
    ) {
        throw new Error(`Clé d'objet invalide : « ${key} »`);
    }
}
