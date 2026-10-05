import { adminDeleteUser, adminSetUserRole, adminSetUserStatus, adminUserList } from '@deveye/types';

import { invalidateAccess } from '../_access';
import { schedulePlanReconcile } from '@/Services/planPauses';
import { forgetSessionsOf } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { deleteUserEverywhere } from '../_users';
import { adminExternalServicesFeature } from './externalServices';
import { adminMaintenanceFeatures } from './maintenance';
import { notifyAdmins } from './notify';

/**
 * Administration des comptes, à l'échelle du site : `admin: true`, et
 * `scope: 'account'` parce que ce sont des actions sur le site et non dans un
 * espace.
 */
const ADMIN = { admin: true, scope: 'account' } as const;

/** Se retirer soi-même son propre accès est toujours une erreur. */
function assertNotSelf(ctx: FeatureContext, userId: number, what: string): void {
    if (userId === ctx.userId) {
        throw new FeatureError('validation', `Vous ne pouvez pas ${what} votre propre compte`);
    }
}

export const adminUserListFeature: FeatureDefinition<
    typeof adminUserList.command,
    typeof adminUserList.input,
    typeof adminUserList.output
> = defineFeature({
    ...adminUserList,
    access: ADMIN,
    handler: async (ctx) => ({ users: await ctx.db.users.listForAdmin() })
});

export const adminSetUserRoleFeature: FeatureDefinition<
    typeof adminSetUserRole.command,
    typeof adminSetUserRole.input,
    typeof adminSetUserRole.output
> = defineFeature({
    ...adminSetUserRole,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        // Se retirer l'administration laisserait potentiellement le site sans
        // aucun administrateur, sans moyen de revenir en arrière.
        assertNotSelf(ctx, input.userId, 'changer le rôle de');
        await ctx.db.users.setRole(input.userId, input.role);
        invalidateAccess();
        // Un administrateur n'a aucune limite : ce rôle ôté, son offre s'applique.
        schedulePlanReconcile(input.userId);
        if (ctx.live) {
            // L'intéressé relit sa session : la page Utilisateurs entre dans
            // son menu ou en sort à l'instant, et son offre avec.
            ctx.live.userChanged(input.userId, ctx.workspaceId, ['workspace', 'account'], ctx.userId);
            await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
        }
        ctx.audit({
            action: 'user.setRole',
            level: 'warning',
            category: 'user',
            description: `Rôle du compte modifié : ${input.role}`,
            metadata: { targetUserId: input.userId }
        });
        return { userId: input.userId, role: input.role };
    }
});

export const adminSetUserStatusFeature: FeatureDefinition<
    typeof adminSetUserStatus.command,
    typeof adminSetUserStatus.input,
    typeof adminSetUserStatus.output
> = defineFeature({
    ...adminSetUserStatus,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        assertNotSelf(ctx, input.userId, 'suspendre');
        await ctx.db.users.setStatus(input.userId, input.status);

        // Suspendre, c'est mettre dehors maintenant : les jetons de
        // rafraîchissement tombent, `invalidateAccess()` fait refuser les sockets
        // déjà ouvertes dès la commande suivante.
        if (input.status === 'suspended') {
            await ctx.db.refreshTokens.revokeUser(input.userId);
            // Ses coffres déverrouillés se referment tout de suite, sans attendre
            // que ses sockets tombent.
            forgetSessionsOf(input.userId);
            // Et la présence : sinon le suspendu resterait dans le roster des
            // autres jusqu'à sa prochaine commande.
            ctx.live?.evictEverywhere(input.userId);
            // Sa session se relit, échoue, et le renvoie à l'écran de connexion
            // sans attendre qu'il agisse.
            ctx.live?.userChanged(input.userId, ctx.workspaceId, ['workspace'], ctx.userId);
        }
        invalidateAccess();
        if (ctx.live) await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);

        ctx.audit({
            action: 'user.setStatus',
            level: 'warning',
            category: 'user',
            description: input.status === 'suspended' ? 'Compte suspendu' : 'Compte réactivé',
            metadata: { targetUserId: input.userId }
        });
        return { userId: input.userId, status: input.status };
    }
});

export const adminDeleteUserFeature: FeatureDefinition<
    typeof adminDeleteUser.command,
    typeof adminDeleteUser.input,
    typeof adminDeleteUser.output
> = defineFeature({
    ...adminDeleteUser,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        assertNotSelf(ctx, input.userId, 'supprimer');
        const target = await ctx.db.users.findById(input.userId);
        if (!target) throw new FeatureError('not_found', 'Compte introuvable');

        await deleteUserEverywhere(ctx, input.userId, { userId: ctx.userId, workspaceId: ctx.workspaceId });

        ctx.audit({
            action: 'user.delete',
            level: 'critical',
            category: 'user',
            description: `Compte supprimé : « ${target.username} », avec tous ses espaces`,
            metadata: { targetUserId: input.userId }
        });
        return { userId: input.userId };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminFeatures: FeatureDefinition<string, any, any>[] = [
    adminUserListFeature,
    adminSetUserRoleFeature,
    adminSetUserStatusFeature,
    adminDeleteUserFeature,
    adminExternalServicesFeature,
    ...adminMaintenanceFeatures
];
