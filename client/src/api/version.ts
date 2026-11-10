/** Même nom que `APP_VERSION_HEADER` côté serveur (`src/version.ts`). */
export const APP_VERSION_HEADER = 'x-deveye-version';

const RELOADED_FOR_KEY = 'deveye.reloadedFor';

export type VersionVerdict = 'current' | 'reload' | 'already';

/** `already` : la page a déjà rechargé pour cette version sans obtenir le bundle qui va avec. */
export function versionVerdict(server: string, own: string, reloadedFor: string | null): VersionVerdict {
    if (server === own) return 'current';
    return reloadedFor === server ? 'already' : 'reload';
}

/**
 * Le serveur a changé de version (un déploiement pendant la coupure) : la page
 * recharge pour prendre le bundle qui va avec. Une seule fois par version
 * serveur : un build servi en retard sur le serveur ferait sinon boucler. Rend
 * `true` quand le rechargement est lancé.
 */
export function reloadIfOutdated(serverVersion: string): boolean {
    try {
        const verdict = versionVerdict(serverVersion, __APP_VERSION__, sessionStorage.getItem(RELOADED_FOR_KEY));
        if (verdict === 'current') {
            sessionStorage.removeItem(RELOADED_FOR_KEY);
            return false;
        }
        if (verdict === 'already') return false;
        sessionStorage.setItem(RELOADED_FOR_KEY, serverVersion);
    } catch {
        return false;
    }
    window.location.reload();
    return true;
}
