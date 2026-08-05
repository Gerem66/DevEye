import {
    adminDeleteUser,
    adminInviteCreate,
    adminInviteList,
    adminInviteRevoke,
    adminSetUserRole,
    adminSetUserStatus,
    adminUserList
} from 'deveye-types';
import type { AdminInvite } from 'deveye-types';

import type { UserInviteRow } from '@/db/repos/userInvites';
import { env } from '@/Utils/Env';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Administration des comptes, à l'échelle du site.
 *
 * Toutes les commandes déclarent `admin: true` — le dispatcheur applique la
 * garde avant le handler — et `scope: 'account'`, parce que ce sont des actions
 * sur le site et non dans un espace : viser un espace partagé dans l'enveloppe
 * ne doit pas en changer la cible.
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
    access: ADMIN,
    handler: async (ctx, input) => {
        // Se retirer l'administration laisserait potentiellement le site sans
        // aucun administrateur, sans moyen de revenir en arrière.
        assertNotSelf(ctx, input.userId, 'changer le rôle de');
        await ctx.db.users.setRole(input.userId, input.role);
        invalidateAccess();
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
    access: ADMIN,
    handler: async (ctx, input) => {
        assertNotSelf(ctx, input.userId, 'suspendre');
        await ctx.db.users.setStatus(input.userId, input.status);
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
    access: ADMIN,
    handler: async (ctx, input) => {
        assertNotSelf(ctx, input.userId, 'supprimer');
        const target = await ctx.db.users.findById(input.userId);
        if (!target) throw new FeatureError('not_found', 'Compte introuvable');

        // Les FK ON DELETE CASCADE emportent l'espace personnel, les espaces
        // partagés dont il est propriétaire, et tout leur contenu.
        await ctx.db.users.delete(input.userId);
        invalidateAccess();

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
    access: ADMIN,
    handler: async (ctx, input) => {
        if (!(await ctx.db.userInvites.revoke(input.token))) {
            throw new FeatureError('not_found', 'Invitation introuvable');
        }
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
