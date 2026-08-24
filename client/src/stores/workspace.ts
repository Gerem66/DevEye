import type { FeatureAccess, FeatureId, WorkspaceCapability, WorkspacePermissions } from '@deveye/types';
import type { Workspace } from '@deveye/types';
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
    /** Droits dans l'espace actif. L'UI s'en sert pour masquer, jamais pour autoriser. */
    permissions: WorkspacePermissions;
    epoch: number;
}

/** Aucun droit : ce que voit une session pas encore chargée. */
const NO_PERMISSIONS: WorkspacePermissions = { isOwner: false, capabilities: [], features: [] };

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

let state: State = { activeId: readActiveId(), workspaces: [], permissions: NO_PERMISSIONS, epoch: 0 };
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
export function syncWorkspacesFromServer(
    workspaces: Workspace[],
    activeWorkspaceId: number,
    permissions: WorkspacePermissions
): void {
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
    state = { activeId, workspaces, permissions, epoch: changed ? state.epoch + 1 : state.epoch };
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
    // Les droits de la cible ne sont pas encore connus : on repart de zéro
    // plutôt que de laisser croire, l'espace d'un instant, que ceux de l'espace
    // précédent s'appliquent ici.
    state = { ...state, activeId: id, permissions: NO_PERMISSIONS, epoch: state.epoch + 1 };
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
    state = { activeId: null, workspaces: [], permissions: NO_PERMISSIONS, epoch: state.epoch + 1 };
    persistActiveId(null);
    emit();
}

/** Applique les droits renvoyés par `workspace.activate`. */
export function setPermissions(permissions: WorkspacePermissions): void {
    state = { ...state, permissions };
    emit();
}

/**
 * Droits de l'appelant dans l'espace actif, sous une forme directement
 * interrogeable. Sert à masquer ce qui n'est pas accordé — le serveur vérifie
 * de toute façon chaque commande.
 */
export function useWorkspacePermissions(): {
    isOwner: boolean;
    can: (c: WorkspaceCapability) => boolean;
    canFeature: (f: FeatureId, level?: FeatureAccess) => boolean;
    /** Gérer les canaux d'alerte de CETTE feature (grant `channels`, 093). */
    canChannels: (f: FeatureId) => boolean;
    /** Permission déclarée de type `toggle` : absente = refusée, propriétaire = accordée. */
    canExtra: (f: FeatureId, key: string) => boolean;
    /**
     * Permission déclarée de type `choice`. Le défaut (le moins privilégié) et
     * la valeur du propriétaire viennent des specs du manifest, que l'appelant
     * fournit : ce magasin ne connaît pas les modules.
     */
    extraValue: (f: FeatureId, key: string, spec: { default: string; ownerValue: string }) => string;
} {
    const { permissions } = useWorkspaceState();
    return {
        isOwner: permissions.isOwner,
        can: (c) => permissions.capabilities.includes(c),
        canFeature: (f, level = 'read') => {
            const granted = permissions.features.find((g) => g.feature === f);
            if (!granted) return false;
            return level === 'read' || granted.access === 'write';
        },
        canChannels: (f) => permissions.features.find((g) => g.feature === f)?.channels === true,
        canExtra: (f, key) =>
            permissions.isOwner || permissions.features.find((g) => g.feature === f)?.extras[key] === true,
        extraValue: (f, key, spec) => {
            if (permissions.isOwner) return spec.ownerValue;
            const value = permissions.features.find((g) => g.feature === f)?.extras[key];
            return typeof value === 'string' ? value : spec.default;
        }
    };
}
