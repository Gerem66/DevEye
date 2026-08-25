import { useCallback, useEffect, useState } from 'react';
import { FEATURE_REGISTRY, WORKSPACE_CAPABILITIES } from '@deveye/types';
import type { WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
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

    const [roles, setRoles] = useState<WorkspaceRole[]>([]);
    const [memberRoles, setMemberRoles] = useState<{ userId: number; roleId: number | null }[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const fail = (e: unknown, fallback: string): void => setError(e instanceof WsError ? e.message : fallback);

    /**
     * Les droits de quelqu'un viennent de changer — **le nôtre y compris**.
     *
     * Le serveur diffuse bien le changement, mais il en exclut son auteur : il a
     * déjà la réponse de sa propre commande. Sauf que cette réponse ne dit rien
     * de *ses* droits à lui, alors qu'il vient peut-être de se retirer une
     * capacité en modifiant son propre rôle. Sans ce rappel, l'onglet Rôles
     * restait ouvert sous les pieds de qui venait de s'en retirer l'accès —
     * alors que la même révocation venue d'ailleurs le faisait disparaître aussitôt.
     *
     * On repasse donc par la **même** clé que la voie distante plutôt que
     * d'appliquer les droits à la main : un seul chemin à garder juste, et
     * l'auteur voit exactement ce que voient les autres.
     *
     * Miroir de l'`invalidateAccess()` du serveur : ces deux commandes-là, et
     * elles seules, peuvent redéfinir les droits d'un membre déjà en place.
     */
    const grantsChanged = (): void => invalidate('workspace.activate');

    const loadRoles = useCallback(async () => {
        try {
            const res = await ws.send('workspace.roleList', {});
            setRoles(res.roles);
            setMemberRoles(res.memberRoles);
        } catch {
            setRoles([]);
            setMemberRoles([]);
        }
    }, []);

    /**
     * Les rôles se relisent aussi quand **quelqu'un d'autre** y touche : deux
     * personnes ouvrent volontiers cette page en même temps, et celle qui
     * regarde ne doit pas rester sur une liste périmée. La clé est déjà
     * invalidée par le sujet `workspace` ; il ne manquait que l'abonnement.
     */
    const rolesVersion = useResourceVersion('workspace.roleList');
    useEffect(() => {
        void loadRoles();
    }, [loadRoles, rolesVersion]);

    /**
     * Exécute une action, en portant l'erreur et l'état occupé.
     *
     * Renvoie si elle a abouti : un appelant qui doit enchaîner — fermer un
     * dialogue, vider un champ — le décide sur ce booléen plutôt qu'en relisant
     * `error`, dont le rendu suivant n'a pas encore eu lieu.
     */
    const run = async (fn: () => Promise<void>, fallback: string): Promise<boolean> => {
        setError(null);
        setBusy(true);
        try {
            await fn();
            return true;
        } catch (e) {
            fail(e, fallback);
            return false;
        } finally {
            setBusy(false);
        }
    };

    return {
        workspace,
        isShared,
        isOwner,
        roles,
        memberRoles,
        error,
        busy,
        clearError: () => setError(null),

        /**
         * Deux rôles de départ pour un onglet encore vide : « Admin » (tout) et
         * « Membre » (toutes les fonctionnalités, aucune administration), ce
         * dernier attribué d'office aux arrivants pour que la première
         * invitation fonctionne sans réglage. Composer un premier rôle à la
         * main est l'obstacle ; l'ajuster ensuite est facile.
         */
        createPresetRoles: () =>
            run(async () => {
                // Les canaux d'alerte (adresses d'astreinte, salons) suivent la
                // ligne du preset : l'Admin les gère, le Membre s'en sert sans
                // pouvoir les modifier.
                const grants = (channels: boolean) =>
                    FEATURE_REGISTRY.map<WorkspaceFeatureGrant>((f) => ({
                        feature: f.id,
                        access: 'write',
                        channels,
                        extras: {}
                    }));
                await ws.send('workspace.roleCreate', {
                    name: 'Admin',
                    color: '#f97316',
                    capabilities: [...WORKSPACE_CAPABILITIES],
                    features: grants(true)
                });
                const member = await ws.send('workspace.roleCreate', {
                    name: 'Membre',
                    color: '#22d3ee',
                    capabilities: [],
                    features: grants(false)
                });
                await ws.send('workspace.roleSetDefault', { roleId: member.role.id });
                await loadRoles();
            }, 'Création des rôles de départ impossible.'),

        createRole: (draft: {
            name: string;
            color: string;
            capabilities: WorkspaceCapability[];
            features: WorkspaceFeatureGrant[];
        }) =>
            run(async () => {
                await ws.send('workspace.roleCreate', draft);
                await loadRoles();
            }, 'Création du rôle impossible.'),

        updateRole: (
            roleId: number,
            draft: {
                name: string;
                color: string;
                capabilities: WorkspaceCapability[];
                features: WorkspaceFeatureGrant[];
            }
        ) =>
            run(async () => {
                await ws.send('workspace.roleUpdate', { roleId, ...draft });
                await loadRoles();
                grantsChanged();
            }, 'Modification du rôle impossible.'),

        deleteRole: (roleId: number) =>
            run(async () => {
                await ws.send('workspace.roleDelete', { roleId });
                await loadRoles();
            }, 'Suppression du rôle impossible.'),

        setDefaultRole: (roleId: number) =>
            run(async () => {
                await ws.send('workspace.roleSetDefault', { roleId });
                await loadRoles();
            }, 'Impossible de définir ce rôle par défaut.'),

        assignRole: (userId: number, roleId: number | null) =>
            run(async () => {
                await ws.send('workspace.assignRole', { userId, roleId });
                await loadRoles();
                grantsChanged();
            }, 'Attribution du rôle impossible.'),

        rename: (name: string) =>
            run(async () => {
                const res = await ws.send('workspace.rename', { name });
                upsertWorkspace(res.workspace);
            }, 'Renommage impossible.'),

        /**
         * Ajoute un membre par son adresse. Le serveur renvoie l'espace complet
         * plutôt que le seul nouvel arrivant : la liste des membres se recompose
         * ainsi d'une source unique, sans reconstruire un `MinimalUser` de
         * fortune côté client.
         */
        addMember: (email: string) =>
            run(async () => {
                const res = await ws.send('workspace.addMember', { email });
                upsertWorkspace(res.workspace);
                await loadRoles();
            }, 'Ajout impossible.'),

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
