import { useSyncExternalStore } from 'react';

/**
 * Les préférences d'affichage de la feature Git, locales au navigateur : ce n'est
 * une propriété ni du dépôt ni de l'espace, deux personnes peuvent vouloir lire
 * le même graphe différemment.
 */
const KEY = 'deveye:git';

export interface GitPrefs {
    /**
     * Réunir les auteurs git sous le membre auquel ils sont rattachés. Activé par
     * défaut : une même personne commite sous plusieurs adresses, les montrer
     * séparément ne sert que pendant le rattachement.
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

export function useGitPrefs(): GitPrefs {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
