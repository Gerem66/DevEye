import {
    WORKSPACE_INVITATION_TTL_SECONDS,
    userInvitations,
    workspaceAcceptInvite,
    workspaceCancelInvite,
    workspaceDeclineInvite,
    workspaceInvitations,
    workspaceInvite
} from '@deveye/types';

import type { ReceivedInvitationRow } from '@/db/repos/workspaceInvitations';
import { invalidateAccess, roleExceeds } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertCoreLimit } from '../_quota';
import { assertShared, describeWorkspace } from './members';

/**
 * On rejoint un espace en acceptant une invitation. L'invitant ne désigne
 * qu'une adresse et n'apprend jamais si un compte la porte : la réponse est la
 * même pour toutes. L'invité la retrouve dans son menu des espaces, où qu'il
 * soit assis, et décide.
 */

const now = (): number => Math.floor(Date.now() / 1000);

/** L'invitation adressée à l'appelant, encore ouverte, ou `not_found`. */
async function received(ctx: FeatureContext, invitationId: number): Promise<ReceivedInvitationRow> {
    const me = await ctx.db.users.findById(ctx.userId);
    const mine = me ? await ctx.db.workspaceInvitations.listByEmail(me.email.toLowerCase(), now()) : [];
    const invitation = mine.find((i) => i.id === invitationId);
    if (!invitation) throw new FeatureError('not_found', 'Invitation introuvable ou expirée');
    return invitation;
}

export const workspaceInviteFeature: FeatureDefinition<
    typeof workspaceInvite.command,
    typeof workspaceInvite.input,
    typeof workspaceInvite.output
> = defineFeature({
    ...workspaceInvite,
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const email = input.email.trim().toLowerCase();
        const target = await ctx.db.users.findByEmail(email);
        // Les membres et leurs adresses sont visibles de l'invitant : le dire ne révèle rien.
        if (target && (await ctx.db.workspaceMembers.isMember(target.id, ctx.workspaceId))) {
            throw new FeatureError('conflict', `« ${target.username} » est déjà membre de cet espace`);
        }
        // Le rôle est fixé maintenant : c'est celui que l'invitant a le droit d'accorder.
        const role = await ctx.db.workspaceRoles.findDefault(ctx.workspaceId);
        if (role && !ctx.can('workspace.roles') && roleExceeds(ctx, role)) {
            throw new FeatureError('forbidden', 'Le rôle par défaut accorde plus que le vôtre : invitation refusée');
        }

        const at = now();
        const pending = await ctx.db.workspaceInvitations.listByWorkspace(ctx.workspaceId, at);
        const renewing = pending.some((i) => i.email === email);
        // L'offre qui compte est celle du propriétaire de l'espace, et chaque
        // invitation ouverte est une place promise : elle compte avec les membres.
        await assertCoreLimit(ctx, {
            ownerUserId: ctx.workspace.ownerUserId,
            fullKey: 'workspace.members',
            label: 'membres par espace',
            countAfter: async () =>
                (await ctx.db.workspaceMembers.listByWorkspaceIds([ctx.workspaceId])).length +
                pending.length +
                (renewing ? 0 : 1)
        });

        await ctx.db.workspaceInvitations.upsert({
            workspaceId: ctx.workspaceId,
            email,
            roleId: role?.id ?? null,
            invitedBy: ctx.userId,
            now: at,
            expiresAt: at + WORKSPACE_INVITATION_TTL_SECONDS
        });
        // L'invité n'est pas dans la salle de cet espace : connecté ailleurs, on
        // le vise par compte pour que l'invitation paraisse dans son menu.
        if (target) ctx.live?.userChanged(target.id, ctx.workspaceId, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.invite',
            level: 'warning',
            description: `Invitation à « ${ctx.workspace.name} » envoyée`,
            metadata: { email }
        });
        return {};
    }
});

export const workspaceInvitationsFeature: FeatureDefinition<
    typeof workspaceInvitations.command,
    typeof workspaceInvitations.input,
    typeof workspaceInvitations.output
> = defineFeature({
    ...workspaceInvitations,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx) => ({
        invitations: (await ctx.db.workspaceInvitations.listByWorkspace(ctx.workspaceId, now())).map((i) => ({
            id: i.id,
            email: i.email,
            expiresAt: Number(i.expires_at)
        }))
    })
});

export const workspaceCancelInviteFeature: FeatureDefinition<
    typeof workspaceCancelInvite.command,
    typeof workspaceCancelInvite.input,
    typeof workspaceCancelInvite.output
> = defineFeature({
    ...workspaceCancelInvite,
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        const invitation = await ctx.db.workspaceInvitations.find(input.invitationId, ctx.workspaceId);
        if (!invitation) throw new FeatureError('not_found', 'Invitation introuvable');
        await ctx.db.workspaceInvitations.remove(invitation.id, ctx.workspaceId);
        const target = await ctx.db.users.findByEmail(invitation.email);
        if (target) ctx.live?.userChanged(target.id, ctx.workspaceId, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.uninvite',
            description: `Invitation à « ${ctx.workspace.name} » annulée`,
            metadata: { email: invitation.email }
        });
        return { invitationId: invitation.id };
    }
});

/**
 * Les trois commandes de l'invité sont de compte, pas d'espace : elles valent
 * d'où qu'il soit assis, et `mutates` bat alors ses propres autres onglets.
 * L'espace qu'il rejoint ou décline est prévenu à part (`changed`).
 */
export const userInvitationsFeature: FeatureDefinition<
    typeof userInvitations.command,
    typeof userInvitations.input,
    typeof userInvitations.output
> = defineFeature({
    ...userInvitations,
    access: { scope: 'account' },
    handler: async (ctx) => {
        const me = await ctx.db.users.findById(ctx.userId);
        const rows = me ? await ctx.db.workspaceInvitations.listByEmail(me.email.toLowerCase(), now()) : [];
        return {
            invitations: rows.map((i) => ({
                id: i.id,
                workspaceId: i.workspace_id,
                workspaceName: i.workspace_name,
                invitedBy: i.inviter_username,
                expiresAt: Number(i.expires_at)
            }))
        };
    }
});

export const workspaceAcceptInviteFeature: FeatureDefinition<
    typeof workspaceAcceptInvite.command,
    typeof workspaceAcceptInvite.input,
    typeof workspaceAcceptInvite.output
> = defineFeature({
    ...workspaceAcceptInvite,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const invitation = await received(ctx, input.invitationId);
        const target = await ctx.db.workspaces.findById(invitation.workspace_id);
        if (!target) throw new FeatureError('not_found', 'Espace introuvable');

        if (!(await ctx.db.workspaceMembers.isMember(ctx.userId, target.id))) {
            // La limite se relit à l'entrée : l'offre du propriétaire a pu changer
            // depuis l'invitation, et c'est le membre qui compte, plus la promesse.
            await assertCoreLimit(ctx, {
                ownerUserId: target.owner_user_id,
                fullKey: 'workspace.members',
                label: 'membres par espace',
                countAfter: async () => (await ctx.db.workspaceMembers.listByWorkspaceIds([target.id])).length + 1
            });
            await ctx.db.workspaceMembers.add({ userId: ctx.userId, workspaceId: target.id });
            // Sans rôle, un arrivant n'a aucun droit (fail-closed) : corrigeable
            // depuis l'onglet Membres.
            if (invitation.role_id !== null) {
                await ctx.db.workspaceRoles.assign(ctx.userId, target.id, invitation.role_id);
            }
            invalidateAccess();
        }
        await ctx.db.workspaceInvitations.remove(invitation.id, target.id);
        ctx.live?.changed(target.id, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.add',
            level: 'warning',
            description: `Espace rejoint sur invitation : « ${target.name} »`,
            metadata: { joinedWorkspaceId: target.id, invitedBy: invitation.invited_by }
        });
        return { workspace: await describeWorkspace(ctx, target.id) };
    }
});

export const workspaceDeclineInviteFeature: FeatureDefinition<
    typeof workspaceDeclineInvite.command,
    typeof workspaceDeclineInvite.input,
    typeof workspaceDeclineInvite.output
> = defineFeature({
    ...workspaceDeclineInvite,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const invitation = await received(ctx, input.invitationId);
        await ctx.db.workspaceInvitations.remove(invitation.id, invitation.workspace_id);
        ctx.live?.changed(invitation.workspace_id, ['workspace'], ctx.userId);
        return { invitationId: invitation.id };
    }
});
