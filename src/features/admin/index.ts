import {
    adminDeleteUser,
    adminInviteCreate,
    adminInviteList,
    adminInviteRevoke,
    adminSetUserRole,
    adminSetUserStatus,
    adminUserList
} from '@deveye/types';
import type { AdminInvite } from '@deveye/types';

import type { UserInviteRow } from '@/db/repos/userInvites';
import { env } from '@/Utils/Env';
import { invalidateAccess } from '../_access';
import { forgetSessionsOf } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { notifyAdmins } from './notify';

/**
 * Administration des comptes, à l'échelle du site : `admin: true`, et
 * `scope: 'account'` parce que ce sont des actions sur le site et non dans un
 * espace.
 */
const ADMIN = { admin: true, scope: 'account' } as const;

function toInvite(row: UserInviteRow, authorName: string, workspaceName: string | null): AdminInvite {
    return {
        token: row.token,
        url: `${env.PUBLIC_ORIGIN.replace(/\/+$/, '')}/register/${row.token}`,
        email: row.email,
        workspaceName,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        maxUses: row.max_uses,
        uses: Number(row.uses),
        createdBy: authorName,
        created: Number(row.created)
    };
}

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
        if (ctx.live) {
            // L'intéressé relit sa session : la page Utilisateurs entre dans
            // son menu ou en sort à l'instant.
            ctx.live.userChanged(input.userId, ctx.workspaceId, ['workspace'], ctx.userId);
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

        // Relevés AVANT la suppression : la cascade emporte les rattachements,
        // et il n'y aurait plus personne à prévenir après coup.
        const shared = (await ctx.db.workspaces.findAccessibleByUser(input.userId)).filter((w) => w.kind === 'shared');
        const members = await ctx.db.workspaceMembers.listByWorkspaceIds(shared.map((w) => w.id));

        // Les FK ON DELETE CASCADE emportent l'espace personnel, les espaces
        // partagés dont il est propriétaire, et tout leur contenu.
        await ctx.db.users.delete(input.userId);
        invalidateAccess();
        forgetSessionsOf(input.userId);
        if (ctx.live) {
            ctx.live.evictEverywhere(input.userId);
            ctx.live.closeSessionsOf(input.userId);
            // Les espaces qu'il possédait ont disparu avec lui : leurs salles se vident.
            for (const w of shared) {
                if (w.owner_user_id === input.userId) ctx.live.evictRoom(w.id);
            }
            // Chaque membre de ses espaces relit sa session : le supprimé sort
            // des listes de membres, et un espace qu'il possédait sort des menus.
            // Par compte : assis ailleurs, un membre ne recevrait rien de la salle.
            for (const m of members) {
                if (m.user_id !== input.userId) {
                    ctx.live.userChanged(m.user_id, m.workspace_id, ['workspace'], ctx.userId);
                }
            }
            await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
        }

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

export const adminInviteListFeature: FeatureDefinition<
    typeof adminInviteList.command,
    typeof adminInviteList.input,
    typeof adminInviteList.output
> = defineFeature({
    ...adminInviteList,
    access: ADMIN,
    handler: async (ctx) => {
        const rows = await ctx.db.userInvites.listActive();
        const authors = await ctx.db.users.findByIds(Array.from(new Set(rows.map((r) => r.created_by))));
        const nameOf = new Map(authors.map((u) => [u.id, u.username]));
        const invites = await Promise.all(
            rows.map(async (r) => {
                const ws = r.workspace_id === null ? null : await ctx.db.workspaces.findById(r.workspace_id);
                return toInvite(r, nameOf.get(r.created_by) ?? '', ws?.name ?? null);
            })
        );
        return { invites };
    }
});

export const adminInviteCreateFeature: FeatureDefinition<
    typeof adminInviteCreate.command,
    typeof adminInviteCreate.input,
    typeof adminInviteCreate.output
> = defineFeature({
    ...adminInviteCreate,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        const email = input.email.trim().toLowerCase();
        const workspace = input.workspaceId === null ? null : await ctx.db.workspaces.findById(input.workspaceId);
        if (input.workspaceId !== null && !workspace) {
            throw new FeatureError('not_found', 'Espace introuvable');
        }
        if (workspace?.kind === 'personal') {
            throw new FeatureError('validation', 'On ne rejoint pas l’espace personnel de quelqu’un');
        }

        const row = await ctx.db.userInvites.create({
            createdBy: ctx.userId,
            email: email === '' ? null : email,
            workspaceId: input.workspaceId,
            ttlSeconds: input.ttlSeconds,
            maxUses: input.maxUses
        });
        ctx.audit({
            action: 'user.invite.create',
            level: 'warning',
            category: 'user',
            description: email === '' ? 'Invitation ouverte créée' : `Invitation créée pour ${email}`,
            metadata: { workspaceId: input.workspaceId, maxUses: input.maxUses }
        });
        if (ctx.live) await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
        const author = await ctx.db.users.findById(ctx.userId);
        return { invite: toInvite(row, author?.username ?? '', workspace?.name ?? null) };
    }
});

export const adminInviteRevokeFeature: FeatureDefinition<
    typeof adminInviteRevoke.command,
    typeof adminInviteRevoke.input,
    typeof adminInviteRevoke.output
> = defineFeature({
    ...adminInviteRevoke,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        if (!(await ctx.db.userInvites.revoke(input.token))) {
            throw new FeatureError('not_found', 'Invitation introuvable');
        }
        if (ctx.live) await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
        ctx.audit({
            action: 'user.invite.revoke',
            level: 'warning',
            category: 'user',
            description: 'Invitation révoquée'
        });
        return { token: input.token };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminFeatures: FeatureDefinition<string, any, any>[] = [
    adminUserListFeature,
    adminSetUserRoleFeature,
    adminSetUserStatusFeature,
    adminDeleteUserFeature,
    adminInviteListFeature,
    adminInviteCreateFeature,
    adminInviteRevokeFeature
];
