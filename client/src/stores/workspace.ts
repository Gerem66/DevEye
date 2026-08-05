import type { Workspace } from 'deveye-types';
import { useSyncExternalStore } from 'react';

/**
 * L'espace de travail actif.
 *
 * Deux rôles distincts, d'où deux états :
 *  - `activeId` est lu **synchroniquement** par `api/ws.ts` pour estampiller
 *    chaque commande. Il doit donc exister avant tout rendu React, y compris au
 *    tout premier paint après un rechargement — d'où sa persistance en
 *    localStorage et sa lecture au chargement du module.
 *  - `workspaces` est la liste servie par la session, pour l'affichage.
 *
 * L'`epoch` s'incrémente à chaque bascule : les vues qui doivent se reconstruire
 * (features montées, listes en cache) l'utilisent comme clé de remontage plutôt
 * que de s'abonner chacune au changement d'espace.
 */

const ACTIVE_KEY = 'deveye:activeWorkspace';

interface State {
    activeId: number | null;
    workspaces: Workspace[];
    epoch: number;
}

function readActiveId(): number | null {
    try {
        const raw = localStorage.getItem(ACTIVE_KEY);
        if (!raw) return null;
        const id = Number(raw);
        return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
        // Mode privé / stockage indisponible : on repart de la session.
        return null;
    }
}

function persistActiveId(id: number | null): void {
    try {
        if (id === null) localStorage.removeItem(ACTIVE_KEY);
        else localStorage.setItem(ACTIVE_KEY, String(id));
    } catch {
        /* ignoré : la session reste la source de vérité */
    }
}

let state: State = { activeId: readActiveId(), workspaces: [], epoch: 0 };
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Lu par `ws.send` pour estampiller l'enveloppe. `null` laisse le serveur
 * choisir l'espace personnel — ce qui est exactement le bon repli avant que la
 * session n'ait répondu.
 */
export function getActiveWorkspaceId(): number | null {
    return state.activeId;
}

export function getWorkspaceState(): State {
    return state;
}

export function useWorkspaceState(): State {
    return useSyncExternalStore(subscribe, getWorkspaceState, getWorkspaceState);
}

/** L'espace actif résolu, ou `null` tant que la session n'a rien fourni. */
export function useActiveWorkspace(): Workspace | null {
    const s = useWorkspaceState();
    return s.workspaces.find((w) => w.id === s.activeId) ?? s.workspaces[0] ?? null;
}

/**
 * Applique ce que la session vient de livrer (connexion, `/me`, rafraîchissement).
 */
export function syncWorkspacesFromServer(workspaces: Workspace[], activeWorkspaceId: number): void {
    // Le choix de l'utilisateur prime tant qu'il y a accès : le serveur ne
    // *propose* une valeur (le favori, sinon l'espace personnel) que pour amorcer
    // une session neuve — après une déconnexion, `resetWorkspace` a vidé l'état —
    // ou pour corriger un espace devenu inaccessible (supprimé, accès révoqué).
    //
    // Sans cette règle, tout rafraîchissement de session (`/api/auth/me`, qui
    // part aussi à la reconnexion de la socket) ramènerait l'utilisateur sur son
    // espace favori et annulerait la bascule qu'il vient de faire.
    const accessible = new Set(workspaces.map((w) => w.id));
    const activeId = state.activeId !== null && accessible.has(state.activeId) ? state.activeId : activeWorkspaceId;

    const changed = state.activeId !== activeId;
    state = { activeId, workspaces, epoch: changed ? state.epoch + 1 : state.epoch };
    persistActiveId(activeId);
    emit();
}

/**
 * Bascule vers un autre espace.
 *
 * Publie l'id immédiatement, pour que les commandes suivantes l'estampillent —
 * `workspace.activate` compris, dont c'est ainsi la cible. L'appelant enchaîne
 * sur cette commande pour récupérer l'apparence et la disposition de l'espace.
 */
export function setActiveWorkspace(id: number): void {
    if (state.activeId === id) return;
    state = { ...state, activeId: id, epoch: state.epoch + 1 };
    persistActiveId(id);
    emit();
}

/** Remplace un espace déjà connu (renommage, arrivée d'un membre…). */
export function upsertWorkspace(workspace: Workspace): void {
    const existing = state.workspaces.some((w) => w.id === workspace.id);
    state = {
        ...state,
        workspaces: existing
            ? state.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
            : [...state.workspaces, workspace]
    };
    emit();
}

/**
 * Remet le store à zéro à la déconnexion. Sans ça, la session suivante — un
 * autre compte sur la même machine — hériterait de l'espace du précédent et
 * estampillerait ses commandes avec un id auquel elle n'a pas accès.
 */
export function resetWorkspace(): void {
    state = { activeId: null, workspaces: [], epoch: state.epoch + 1 };
    persistActiveId(null);
    emit();
}
