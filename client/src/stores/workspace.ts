import type { FeatureAccess, FeatureId, WorkspaceCapability, WorkspacePermissions } from '@deveye/types';
import type { Workspace } from '@deveye/types';
import { useSyncExternalStore } from 'react';
import { useHiddenFeatures } from './maintenance';

/**
 * L'espace de travail actif. `activeId` est lu synchroniquement par `api/ws.ts`
 * pour estampiller chaque commande : il doit exister avant tout rendu React, y
 * compris au premier paint après un rechargement, d'où sa persistance en
 * localStorage et sa lecture au chargement du module. `workspaces` est la liste
 * servie par la session, pour l'affichage.
 *
 * L'`epoch` s'incrémente à chaque bascule : les vues qui doivent se reconstruire
 * l'utilisent comme clé de remontage plutôt que de s'abonner chacune au
 * changement d'espace.
 *
 * Un espace peut vivre sur une instance distante (`activeInstanceId`). Son id
 * reste celui que SON serveur lui donne, c'est lui que l'enveloppe porte : deux
 * instances numérotent chacune depuis 1, donc tout ce qui se sert d'un espace
 * comme CLÉ passe par `workspaceKey`, jamais par l'id seul.
 */

const ACTIVE_KEY = 'deveye:activeWorkspace';
/** L'espace distant où l'on se trouvait : la page rouvre toujours chez elle, puis y retourne. */
const ACTIVE_REMOTE_KEY = 'deveye:activeRemote';

export interface WorkspaceRef {
    /** `null` : cette instance. Sinon l'id de l'instance distante du compte. */
    instanceId: number | null;
    id: number;
}

export const workspaceKey = (ref: WorkspaceRef): string =>
    ref.instanceId === null ? String(ref.id) : `r${ref.instanceId}-${ref.id}`;

interface State {
    activeId: number | null;
    activeInstanceId: number | null;
    /** Les espaces de cette instance. Ceux des instances distantes sont dans `remoteWorkspaces`. */
    workspaces: Workspace[];
    remoteWorkspaces: Readonly<Record<number, readonly Workspace[]>>;
    /** Droits dans l'espace actif. L'UI s'en sert pour masquer, jamais pour autoriser. */
    permissions: WorkspacePermissions;
    epoch: number;
}

/** Aucun droit : ce que voit une session pas encore chargée. */
const NO_PERMISSIONS: WorkspacePermissions = { isOwner: false, capabilities: [], features: [], itemOverrides: [] };

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

/** Lu une fois par la reprise d'une session distante, qui décide d'y retourner ou non. */
export function readLastRemoteWorkspace(): WorkspaceRef | null {
    try {
        const match = /^(\d+):(\d+)$/.exec(localStorage.getItem(ACTIVE_REMOTE_KEY) ?? '');
        return match ? { instanceId: Number(match[1]), id: Number(match[2]) } : null;
    } catch {
        return null;
    }
}

function persistRemoteWorkspace(ref: WorkspaceRef | null): void {
    try {
        if (ref === null || ref.instanceId === null) localStorage.removeItem(ACTIVE_REMOTE_KEY);
        else localStorage.setItem(ACTIVE_REMOTE_KEY, `${ref.instanceId}:${ref.id}`);
    } catch {
        /* ignoré */
    }
}

let state: State = {
    activeId: readActiveId(),
    activeInstanceId: null,
    workspaces: [],
    remoteWorkspaces: {},
    permissions: NO_PERMISSIONS,
    epoch: 0
};
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Hors React : `api/ws.ts` y apprend qu'on a changé d'instance. */
export const onWorkspaceChange = subscribe;

/**
 * Lu par `ws.send` pour estampiller l'enveloppe. `null` laisse le serveur choisir
 * l'espace personnel, le bon repli avant que la session n'ait répondu.
 */
export function getActiveWorkspaceId(): number | null {
    return state.activeId;
}

/** L'instance que visent les commandes : `null` pour celle-ci. Lu par `api/ws.ts` et `api/http.ts`. */
export function getActiveInstanceId(): number | null {
    return state.activeInstanceId;
}

/** La clé de l'espace actif, pour tout ce qui range quelque chose par espace dans le navigateur. */
export function getActiveWorkspaceKey(): string | null {
    return state.activeId === null ? null : workspaceKey({ instanceId: state.activeInstanceId, id: state.activeId });
}

export function getWorkspaceState(): State {
    return state;
}

export function useWorkspaceState(): State {
    return useSyncExternalStore(subscribe, getWorkspaceState, getWorkspaceState);
}

/** Les espaces de l'instance où l'on se trouve : ceux dont un id reçu d'elle peut parler. */
function hereOf(s: State): readonly Workspace[] {
    return s.activeInstanceId === null ? s.workspaces : (s.remoteWorkspaces[s.activeInstanceId] ?? []);
}

export function getWorkspacesHere(): readonly Workspace[] {
    return hereOf(state);
}

export function useWorkspacesHere(): readonly Workspace[] {
    return hereOf(useWorkspaceState());
}

/**
 * L'offre du propriétaire tient ce compte hors de l'espace : l'espace partagé
 * est en pause, ou lui-même l'est. Le propriétaire n'est jamais dehors.
 */
export function isShutOutByPlan(w: Workspace, userId: number | undefined): boolean {
    if (userId === undefined || w.ownerUserId === userId) return false;
    return w.planPaused || w.pausedMemberIds.includes(userId);
}

/** L'espace actif résolu, ou `null` tant que la session n'a rien fourni. */
export function useActiveWorkspace(): Workspace | null {
    const s = useWorkspaceState();
    if (s.activeInstanceId !== null) {
        return s.remoteWorkspaces[s.activeInstanceId]?.find((w) => w.id === s.activeId) ?? null;
    }
    return s.workspaces.find((w) => w.id === s.activeId) ?? s.workspaces[0] ?? null;
}

/** Applique ce que la session vient de livrer (connexion, `/me`, rafraîchissement). */
export function syncWorkspacesFromServer(
    workspaces: Workspace[],
    activeWorkspaceId: number,
    permissions: WorkspacePermissions
): void {
    // Le choix de l'utilisateur prime tant qu'il y a accès : la valeur du serveur
    // n'amorce qu'une session neuve ou corrige un espace devenu inaccessible. Sinon
    // tout rafraîchissement de session annulerait la bascule qu'il vient de faire.
    // Assis dans un espace distant, cette session-ci ne dit rien de l'espace
    // actif ni de ses droits : seule la liste d'ici se rafraîchit.
    if (state.activeInstanceId !== null) {
        state = { ...state, workspaces };
        emit();
        return;
    }
    const accessible = new Set(workspaces.map((w) => w.id));
    const activeId = state.activeId !== null && accessible.has(state.activeId) ? state.activeId : activeWorkspaceId;

    const changed = state.activeId !== activeId;
    state = { ...state, activeId, workspaces, permissions, epoch: changed ? state.epoch + 1 : state.epoch };
    persistActiveId(activeId);
    emit();
}

/** Les espaces qu'une instance distante vient de livrer ; `null` la retire (instance oubliée). */
export function setRemoteWorkspaces(instanceId: number, workspaces: readonly Workspace[] | null): void {
    const next = { ...state.remoteWorkspaces };
    if (workspaces === null) delete next[instanceId];
    else next[instanceId] = workspaces;
    state = { ...state, remoteWorkspaces: next };
    emit();
}

/**
 * Bascule vers un autre espace. Publie l'id immédiatement pour que les commandes
 * suivantes l'estampillent, `workspace.activate` compris : l'appelant enchaîne
 * sur elle pour récupérer l'apparence et la disposition.
 */
export function setActiveWorkspace(id: number, instanceId: number | null = null): void {
    if (state.activeId === id && state.activeInstanceId === instanceId) return;
    // Les droits de la cible ne sont pas encore connus : ceux de l'espace
    // précédent ne doivent pas sembler s'appliquer, même un instant.
    state = {
        ...state,
        activeId: id,
        activeInstanceId: instanceId,
        permissions: NO_PERMISSIONS,
        epoch: state.epoch + 1
    };
    // `ACTIVE_KEY` reste le dernier espace d'ICI : c'est là que la page rouvre,
    // la session distante n'existant pas encore à ce moment.
    if (instanceId === null) persistActiveId(id);
    persistRemoteWorkspace({ instanceId, id });
    emit();
}

/**
 * Remplace un espace déjà connu (renommage, arrivée d'un membre…). Sans
 * instance nommée, dans la liste de celle où l'on se trouve : c'est elle qui
 * vient de répondre.
 */
export function upsertWorkspace(workspace: Workspace, instanceId: number | null = state.activeInstanceId): void {
    const merge = (list: readonly Workspace[]): Workspace[] =>
        list.some((w) => w.id === workspace.id)
            ? list.map((w) => (w.id === workspace.id ? workspace : w))
            : [...list, workspace];
    state =
        instanceId === null
            ? { ...state, workspaces: merge(state.workspaces) }
            : {
                  ...state,
                  remoteWorkspaces: {
                      ...state.remoteWorkspaces,
                      [instanceId]: merge(state.remoteWorkspaces[instanceId] ?? [])
                  }
              };
    emit();
}

/**
 * L'espace d'ICI où l'on se trouvait n'existe plus pour nous (quitté, supprimé) :
 * on l'oublie, et la session que l'appelant relit ensuite replace le client sur
 * un espace valide. Les espaces des instances distantes ne sont pas concernés :
 * leurs sessions vivent toujours.
 */
export function forgetActiveWorkspace(): void {
    state = {
        ...state,
        activeId: null,
        activeInstanceId: null,
        workspaces: [],
        permissions: NO_PERMISSIONS,
        epoch: state.epoch + 1
    };
    persistActiveId(null);
    persistRemoteWorkspace(null);
    emit();
}

/**
 * Remet le store à zéro, à la déconnexion : la session suivante ne doit pas
 * estampiller ses commandes avec un espace auquel elle n'a pas accès.
 */
export function resetWorkspace(): void {
    state = {
        activeId: null,
        activeInstanceId: null,
        workspaces: [],
        remoteWorkspaces: {},
        permissions: NO_PERMISSIONS,
        epoch: state.epoch + 1
    };
    persistActiveId(null);
    persistRemoteWorkspace(null);
    emit();
}

/** Applique les droits renvoyés par `workspace.activate`. */
export function setPermissions(permissions: WorkspacePermissions): void {
    state = { ...state, permissions };
    emit();
}

/** La surcharge posée sur cet élément pour le rôle de l'appelant, s'il y en a une. */
function overrideOf(
    permissions: WorkspacePermissions,
    feature: FeatureId,
    itemId: string
): WorkspacePermissions['itemOverrides'][number] | undefined {
    return permissions.itemOverrides.find((o) => o.feature === feature && o.itemId === itemId);
}

/**
 * Droits de l'appelant dans l'espace actif. Sert à masquer ce qui n'est pas
 * accordé ; le serveur vérifie de toute façon chaque commande.
 */
export function useWorkspacePermissions(): {
    isOwner: boolean;
    can: (c: WorkspaceCapability) => boolean;
    /**
     * `itemId` répond pour CET élément, surcharge comprise : la fonctionnalité
     * ne donne qu'un défaut, et une ligne peut l'ouvrir comme le fermer. Sans
     * lui, la réponse est celle de la fonctionnalité.
     */
    canFeature: (f: FeatureId, level?: FeatureAccess, itemId?: string) => boolean;
    /** Gérer les canaux d'alerte de cette feature (grant `channels`). */
    canChannels: (f: FeatureId) => boolean;
    /**
     * Régler les permissions par élément de cette feature (grant
     * `itemPermissions`), ou gouverner les rôles, qui l'englobe.
     */
    canManageItemGrants: (f: FeatureId) => boolean;
    /**
     * Permission déclarée de type `toggle` : absente = refusée, propriétaire =
     * accordée. `itemId` répond pour CET élément, surcharge comprise.
     */
    canExtra: (f: FeatureId, key: string, itemId?: string) => boolean;
    /**
     * Permission déclarée de type `choice`. Le défaut, le moins privilégié, et la
     * valeur du propriétaire viennent des specs que l'appelant fournit : ce magasin
     * ne connaît pas les modules.
     */
    extraValue: (f: FeatureId, key: string, spec: { default: string; ownerValue: string }) => string;
} {
    const { permissions } = useWorkspaceState();
    const hidden = useHiddenFeatures();
    return {
        isOwner: permissions.isOwner,
        can: (c) => permissions.capabilities.includes(c),
        // La surcharge de cet élément, s'il y en a une pour le rôle de l'appelant.
        canFeature: (f, level = 'read', itemId) => {
            // Une feature en préversion n'existe pas pour ce compte, quel que soit son rôle.
            if (hidden.has(f)) return false;
            const granted = permissions.features.find((g) => g.feature === f);
            // Le plancher : sans accès à la fonctionnalité, aucun élément
            // n'existe, et rien ne se surcharge.
            if (!granted) return false;
            const override = itemId === undefined ? undefined : overrideOf(permissions, f, itemId)?.access;
            const effective = override ?? granted.access;
            if (effective === 'none') return false;
            return level === 'read' || effective === 'write';
        },
        canChannels: (f) => permissions.features.find((g) => g.feature === f)?.channels === true,
        canManageItemGrants: (f) =>
            permissions.isOwner ||
            permissions.capabilities.includes('workspace.roles') ||
            permissions.features.find((g) => g.feature === f)?.itemPermissions === true,
        canExtra: (f, key, itemId) => {
            if (permissions.isOwner) return true;
            const forced = itemId === undefined ? undefined : overrideOf(permissions, f, itemId)?.extras[key];
            return forced ?? permissions.features.find((g) => g.feature === f)?.extras[key] === true;
        },
        extraValue: (f, key, spec) => {
            if (permissions.isOwner) return spec.ownerValue;
            const value = permissions.features.find((g) => g.feature === f)?.extras[key];
            return typeof value === 'string' ? value : spec.default;
        }
    };
}
