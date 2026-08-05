import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceInvite } from 'deveye-types';

import { ws, WsError } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { resetWorkspace, upsertWorkspace, useActiveWorkspace } from '@/stores/workspace';

/**
 * Toute la logique de la page « Espace », séparée de son rendu.
 *
 * Même partage que `Features/Clients` : le composant décrit l'écran, ce hook
 * porte l'état, les appels et les erreurs. Une seule chaîne d'erreur partagée,
 * affichée une fois en tête de page plutôt qu'une par action.
 */
export function useWorkspaceAdmin() {
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const isShared = workspace?.kind === 'shared';
    const isOwner = workspace !== null && user !== null && workspace.ownerUserId === user.id;

    const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
    const [sharedKey, setSharedKey] = useState<{ enabled: boolean; applicable: boolean; blockers: string[] } | null>(
        null
    );
    const [loadingInvites, setLoadingInvites] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const fail = (e: unknown, fallback: string): void => setError(e instanceof WsError ? e.message : fallback);

    const loadInvites = useCallback(async () => {
        if (!isShared) return;
        setLoadingInvites(true);
        try {
            const res = await ws.send('workspace.inviteList', {});
            setInvites(res.invites);
        } catch (e) {
            // Un membre non-propriétaire n'a pas le droit de lister : ce n'est
            // pas une erreur à afficher, juste une section qu'il ne verra pas.
            if (!(e instanceof WsError && e.code === 'forbidden')) fail(e, 'Impossible de charger les invitations.');
            setInvites([]);
        } finally {
            setLoadingInvites(false);
        }
    }, [isShared]);

    const loadSharedKey = useCallback(async () => {
        try {
            setSharedKey(await ws.send('workspace.sharedKeyStatus', {}));
        } catch {
            setSharedKey(null);
        }
    }, []);

    useEffect(() => {
        void loadInvites();
        void loadSharedKey();
    }, [loadInvites, loadSharedKey]);

    const run = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
        setError(null);
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            fail(e, fallback);
        } finally {
            setBusy(false);
        }
    };

    return {
        workspace,
        isShared,
        isOwner,
        invites,
        loadingInvites,
        sharedKey,
        error,
        busy,
        clearError: () => setError(null),

        /**
         * Bascule l'espace sur sa propre clé. Le contenu existant est relu avec
         * la clé du propriétaire puis réécrit sous celle de l'espace — d'où la
         * session déverrouillée exigée par le serveur.
         */
        enableSharedKey: () =>
            run(async () => {
                await ws.send('workspace.enableSharedKey', {});
                await loadSharedKey();
            }, 'Activation de la clé d’espace impossible.'),

        rename: (name: string) =>
            run(async () => {
                const res = await ws.send('workspace.rename', { name });
                upsertWorkspace(res.workspace);
            }, 'Renommage impossible.'),

        createInvite: (ttlSeconds: number | null, maxUses: number | null) =>
            run(async () => {
                const res = await ws.send('workspace.inviteCreate', { ttlSeconds, maxUses });
                setInvites((prev) => [res.invite, ...prev]);
            }, 'Création du lien impossible.'),

        revokeInvite: (token: string) =>
            run(async () => {
                await ws.send('workspace.inviteRevoke', { token });
                setInvites((prev) => prev.filter((i) => i.token !== token));
            }, 'Révocation impossible.'),

        removeMember: (userId: number) =>
            run(async () => {
                await ws.send('workspace.removeMember', { userId });
                if (workspace) {
                    upsertWorkspace({ ...workspace, users: workspace.users.filter((u) => u.id !== userId) });
                }
            }, 'Exclusion impossible.'),

        /**
         * Quitter ou supprimer fait perdre l'espace courant. `resetWorkspace`
         * efface l'id local, puis `onDone` recharge la session : le serveur
         * replace alors le client sur un espace valide (le favori, sinon le
         * personnel) au lieu de le laisser sur un id devenu interdit.
         */
        leave: (onDone: () => void) =>
            run(async () => {
                await ws.send('workspace.leave', {});
                resetWorkspace();
                onDone();
            }, 'Impossible de quitter cet espace.'),

        remove: (onDone: () => void) =>
            run(async () => {
                if (!workspace) return;
                await ws.send('workspace.delete', { workspaceId: workspace.id });
                resetWorkspace();
                onDone();
            }, 'Suppression impossible.')
    };
}

export type WorkspaceAdmin = ReturnType<typeof useWorkspaceAdmin>;

/** Rend une échéance lisible, ou « jamais » pour un lien sans expiration. */
export function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) return 'n’expire pas';
    const remaining = expiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return 'expiré';
    if (remaining < 3600) return `expire dans ${Math.ceil(remaining / 60)} min`;
    if (remaining < 86400) return `expire dans ${Math.ceil(remaining / 3600)} h`;
    return `expire dans ${Math.ceil(remaining / 86400)} j`;
}

/** « 1 / 3 utilisations », ou « illimité » quand aucun plafond n'est fixé. */
export function formatUses(uses: number, maxUses: number | null): string {
    return maxUses === null ? `${uses} utilisation${uses > 1 ? 's' : ''} · illimité` : `${uses} / ${maxUses}`;
}
