import { hasLocalWork, onTasksChange } from '../stores/tasks';

/** Même nom que `APP_VERSION_HEADER` côté serveur (`src/version.ts`). */
export const APP_VERSION_HEADER = 'x-deveye-version';

const RELOADED_FOR_KEY = 'deveye.reloadedFor';

export type VersionVerdict = 'current' | 'reload' | 'already';

/** `already` : la page a déjà rechargé pour cette version sans obtenir le bundle qui va avec. */
export function versionVerdict(server: string, own: string, reloadedFor: string | null): VersionVerdict {
    if (server === own) return 'current';
    return reloadedFor === server ? 'already' : 'reload';
}

/** Le rechargement attend la fin d'un travail fait dans l'onglet : un seul guetteur à la fois. */
let waiting: (() => void) | null = null;

/**
 * Le serveur a changé de version (un déploiement pendant la coupure) : la page
 * recharge pour prendre le bundle qui va avec. Une seule fois par version
 * serveur : un build servi en retard sur le serveur ferait sinon boucler. Rend
 * `true` quand le rechargement est lancé.
 *
 * Recharger tuerait une copie ou un assemblage en cours dans l'onglet : le
 * rechargement se fait alors à leur fin.
 */
export function reloadIfOutdated(serverVersion: string): boolean {
    try {
        const verdict = versionVerdict(serverVersion, __APP_VERSION__, sessionStorage.getItem(RELOADED_FOR_KEY));
        if (verdict === 'current') {
            sessionStorage.removeItem(RELOADED_FOR_KEY);
            return false;
        }
        if (verdict === 'already') return false;
        if (hasLocalWork()) {
            waiting ??= onTasksChange(() => {
                if (hasLocalWork()) return;
                waiting?.();
                waiting = null;
                reloadIfOutdated(serverVersion);
            });
            return false;
        }
        sessionStorage.setItem(RELOADED_FOR_KEY, serverVersion);
    } catch {
        return false;
    }
    window.location.reload();
    return true;
}
