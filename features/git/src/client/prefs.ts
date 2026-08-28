import { useSyncExternalStore } from 'react';

/**
 * Les préférences d'affichage de la feature Git.
 *
 * **Locales au navigateur, et c'est délibéré.** Ce n'est pas une propriété du
 * dépôt ni de l'espace : deux personnes regardant le même graphe peuvent
 * vouloir le lire différemment, et rien ici ne mérite une colonne en base, une
 * migration et une diffusion `live`. Même parti pris que les préférences du
 * terminal distant (`stores/terminalPrefs`).
 */
const KEY = 'deveye:git';

export interface GitPrefs {
    /**
     * Réunir les auteurs git sous le membre auquel ils sont rattachés.
     *
     * Activé par défaut : c'est l'état qu'on veut une fois le rattachement fait.
     * Une même personne commite sous trois adresses selon la machine ; les
     * montrer séparément est utile *pendant* qu'on les rattache, plus après. Le
     * décocher rend la légende brute, un jeton par auteur git.
     */
    groupAuthorsByMember: boolean;
}

const DEFAULT: GitPrefs = { groupAuthorsByMember: true };

function load(): GitPrefs {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const parsed = JSON.parse(raw) as Partial<GitPrefs>;
        return {
            groupAuthorsByMember:
                typeof parsed.groupAuthorsByMember === 'boolean'
                    ? parsed.groupAuthorsByMember
                    : DEFAULT.groupAuthorsByMember
        };
    } catch {
        return DEFAULT;
    }
}

let state: GitPrefs = load();
const listeners = new Set<() => void>();

/** Fusionne une modification partielle, la persiste et prévient les abonnés. */
export function setGitPrefs(patch: Partial<GitPrefs>): void {
    state = { ...state, ...patch };
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        /* stockage indisponible (navigation privée, quota) : la valeur en mémoire suffit */
    }
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): GitPrefs {
    return state;
}

/** Les préférences d'affichage, réactives. */
export function useGitPrefs(): GitPrefs {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
