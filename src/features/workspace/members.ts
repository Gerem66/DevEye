import { workspaceLeave, workspaceMemberShares, workspaceRemoveMember, workspaceRename } from '@deveye/types';
import type { FeatureId, Workspace } from '@deveye/types';

import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import { detachLinks } from '../sharing/_shared';
import { schedulePlanReconcile, workspacePauses } from '@/Services/planPauses';
import { createOpenCipher } from '@/Services/SecureStore';

/**
 * Gestion des membres d'un espace, par les capacités `workspace.members` et
 * `workspace.manage`. L'entrée d'un membre est dans `invitations.ts`.
 */

/** Un espace personnel n'a pas de membres : il est personnel. */
export function assertShared(ctx: FeatureContext): void {
    if (ctx.workspace.kind === 'personal') {
        throw new FeatureError('validation', 'L’espace personnel ne se partage pas');
    }
}

export const workspaceRenameFeature: FeatureDefinition<
    typeof workspaceRename.command,
    typeof workspaceRename.input,
    typeof workspaceRename.output
> = defineFeature({
    ...workspaceRename,
    mutates: true,
    access: { capabilities: ['workspace.manage'] },
    handler: async (ctx, input) => {
        const name = input.name.trim();
        await ctx.db.workspaces.rename(ctx.workspaceId, name);
        ctx.audit({
            action: 'workspace.rename',
            description: `Espace renommé : « ${ctx.workspace.name} » → « ${name} »`
        });
        return { workspace: await describeWorkspace(ctx, ctx.workspaceId) };
    }
});

/**
 * Un membre qui part emporte ses projections : celles qu'il avait réglées de
 * cet espace vers les siens (il y lirait encore ce qu'on vient de lui fermer)
 * et celles des siens vers cet espace (une donnée dont il ne pourrait plus
 * répondre). Rend ce qui a été retiré.
 */
export async function dropSharesOf(
    db: Pick<FeatureContext['db'], 'itemSharing'>,
    userId: number,
    workspaceId: number
): Promise<number> {
    const shares = await db.itemSharing.sharedByUserAround(userId, workspaceId);
    for (const share of shares) {
        await db.itemSharing.unshare(share.workspace_id, share.feature, share.item_id);
        await detachLinks(share.feature as FeatureId, share.item_id, [share.workspace_id]);
    }
    return shares.length;
}

export const workspaceMemberSharesFeature: FeatureDefinition<
    typeof workspaceMemberShares.command,
    typeof workspaceMemberShares.input,
    typeof workspaceMemberShares.output
> = defineFeature({
    ...workspaceMemberShares,
    handler: async (ctx, input) => {
        if (input.userId !== ctx.userId) ctx.assertCan('workspace.members');
        const shares = await ctx.db.itemSharing.sharedByUserAround(input.userId, ctx.workspaceId);
        return {
            shares: await Promise.all(
                shares.map(async (share) => {
                    // L'intitulé se lit chez l'élément, sous la clé de son domicile.
                    const cipher =
                        share.home_workspace_id === ctx.workspaceId
                            ? ctx.secure.open
                            : createOpenCipher(ctx.db, ctx.crypt, share.home_workspace_id);
                    const label = await moduleItems(share.feature, ctx.db)
                        ?.labelOf(cipher, share.item_id, share.home_workspace_id)
                        .catch(() => null);
                    return { feature: share.feature, label: label ?? `#${share.item_id}` };
                })
            )
        };
    }
});

export const workspaceLeaveFeature: FeatureDefinition<
    typeof workspaceLeave.command,
    typeof workspaceLeave.input,
    typeof workspaceLeave.output
> = defineFeature({
    ...workspaceLeave,
    mutates: true,
    handler: async (ctx) => {
        assertShared(ctx);
        if (ctx.isOwner) {
            throw new FeatureError(
                'forbidden',
                'Vous êtes propriétaire de cet espace : supprimez-le plutôt que de le quitter'
            );
        }
        const sharesDropped = await dropSharesOf(ctx.db, ctx.userId, ctx.workspaceId);
        await ctx.db.workspaceMembers.remove(ctx.userId, ctx.workspaceId);
        await clearFavoriteIfPointingAt(ctx, ctx.userId, ctx.workspaceId);
        invalidateAccess();
        // Sa place revient au membre en pause arrivé le plus tôt.
        schedulePlanReconcile(ctx.workspace.ownerUserId);
        ctx.live?.evict(ctx.workspaceId, ctx.userId);
        ctx.audit({
            action: 'workspace.leave',
            level: 'warning',
            description: `Espace quitté : « ${ctx.workspace.name} »`,
            metadata: { sharesDropped }
        });
        return { workspaceId: ctx.workspaceId };
    }
});

export const workspaceRemoveMemberFeature: FeatureDefinition<
    typeof workspaceRemoveMember.command,
    typeof workspaceRemoveMember.input,
    typeof workspaceRemoveMember.output
> = defineFeature({
    ...workspaceRemoveMember,
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        if (input.userId === ctx.workspace.ownerUserId) {
            throw new FeatureError('validation', 'Le propriétaire ne peut pas être exclu de son espace');
        }
        const sharesDropped = await dropSharesOf(ctx.db, input.userId, ctx.workspaceId);
        await ctx.db.workspaceMembers.remove(input.userId, ctx.workspaceId);
        // Le favori de l'exclu pointait peut-être ici : sans ça, sa prochaine
        // connexion viserait un espace auquel il n'a plus accès.
        await clearFavoriteIfPointingAt(ctx, input.userId, ctx.workspaceId);
        invalidateAccess();
        schedulePlanReconcile(ctx.workspace.ownerUserId);
        ctx.live?.evict(ctx.workspaceId, input.userId);
        // Miroir de l'ajout : assis dans un autre espace, l'exclu ne recevrait
        // pas la diffusion de celui-ci, et l'entrée resterait dans son menu.
        ctx.live?.userChanged(input.userId, ctx.workspaceId, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.remove',
            level: 'warning',
            description: `Membre exclu de « ${ctx.workspace.name} »`,
            metadata: { removedUserId: input.userId, sharesDropped }
        });
        return { userId: input.userId };
    }
});

/** Un espace tel que le client l'attend, membres résolus. */
export async function describeWorkspace(ctx: FeatureContext, workspaceId: number): Promise<Workspace> {
    const row = await ctx.db.workspaces.findById(workspaceId);
    if (!row) throw new FeatureError('not_found', 'Espace introuvable');
    const members = await ctx.db.workspaceMembers.listByWorkspaceIds([workspaceId]);
    const users = await ctx.db.users.findByIds(members.map((m) => m.user_id));
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        logo: row.logo,
        ownerUserId: row.owner_user_id,
        users: users.map((u) => ({
            id: u.id,
            email: u.email,
            username: u.username,
            avatar: u.avatar,
            color: u.color,
            lastSeen: Number(u.last_seen),
            created: Number(u.created)
        })),
        features: parseFeatures(row.features),
        created: Number(row.created),
        ...workspacePauses(
            row.id,
            members.map((m) => m.user_id)
        )
    };
}

/**
 * Un favori qui pointe un espace perdu bloquerait la connexion suivante sur un
 * espace inaccessible. On le remet à zéro en même temps qu'on retire l'accès.
 */
async function clearFavoriteIfPointingAt(ctx: FeatureContext, userId: number, workspaceId: number): Promise<void> {
    const user = await ctx.db.users.findById(userId);
    if (user?.default_workspace_id === workspaceId) {
        await ctx.db.users.setDefaultWorkspace(userId, null);
    }
}

function parseFeatures(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}
