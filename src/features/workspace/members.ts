import {
    workspaceInviteAccept,
    workspaceInviteCreate,
    workspaceInviteList,
    workspaceInvitePreview,
    workspaceInviteRevoke,
    workspaceLeave,
    workspaceRemoveMember,
    workspaceRename
} from 'deveye-types';
import type { Workspace, WorkspaceInvite, WorkspaceInviteRow } from 'deveye-types';

import { env } from '@/Utils/Env';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Gestion des membres et des invitations d'un espace.
 *
 * **Qui peut administrer ?** Le propriétaire, et lui seul, tant que les rôles
 * n'existent pas. C'est délibérément restrictif : ouvrir l'invitation à tout
 * membre laisserait un espace grandir sans que son propriétaire le sache, et
 * l'inverse est trivial à assouplir une fois les rôles en place — alors que
 * reprendre un droit déjà donné ne l'est pas.
 */
function assertOwner(ctx: FeatureContext): void {
    if (!ctx.isOwner) {
        throw new FeatureError('forbidden', 'Réservé au propriétaire de l’espace');
    }
}

/** Un espace personnel n'a ni membres ni invitations : il est personnel. */
function assertShared(ctx: FeatureContext): void {
    if (ctx.workspace.kind === 'personal') {
        throw new FeatureError('validation', 'L’espace personnel ne se partage pas');
    }
}

function toInvite(row: WorkspaceInviteRow, authorName: string): WorkspaceInvite {
    return {
        token: row.token,
        // Le lien est construit ici : le client ne connaît pas forcément
        // l'origine publique (proxy, nom de domaine) et ne doit pas la deviner.
        url: `${env.PUBLIC_ORIGIN.replace(/\/+$/, '')}/invite/${row.token}`,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        maxUses: row.max_uses,
        uses: Number(row.uses),
        createdBy: authorName,
        created: Number(row.created)
    };
}

export const workspaceRenameFeature: FeatureDefinition<
    typeof workspaceRename.command,
    typeof workspaceRename.input,
    typeof workspaceRename.output
> = defineFeature({
    ...workspaceRename,
    handler: async (ctx, input) => {
        assertOwner(ctx);
        const name = input.name.trim();
        await ctx.db.workspaces.rename(ctx.workspaceId, name);
        ctx.audit({
            action: 'workspace.rename',
            description: `Espace renommé : « ${ctx.workspace.name} » → « ${name} »`
        });
        return { workspace: await describe(ctx, ctx.workspaceId) };
    }
});

export const workspaceLeaveFeature: FeatureDefinition<
    typeof workspaceLeave.command,
    typeof workspaceLeave.input,
    typeof workspaceLeave.output
> = defineFeature({
    ...workspaceLeave,
    handler: async (ctx) => {
        assertShared(ctx);
        if (ctx.isOwner) {
            throw new FeatureError(
                'forbidden',
                'Vous êtes propriétaire de cet espace : supprimez-le plutôt que de le quitter'
            );
        }
        await ctx.db.workspaceMembers.remove(ctx.userId, ctx.workspaceId);
        await clearFavoriteIfPointingAt(ctx, ctx.userId, ctx.workspaceId);
        invalidateAccess();
        ctx.audit({
            action: 'workspace.leave',
            level: 'warning',
            description: `Espace quitté : « ${ctx.workspace.name} »`
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
    handler: async (ctx, input) => {
        assertShared(ctx);
        assertOwner(ctx);
        if (input.userId === ctx.workspace.ownerUserId) {
            throw new FeatureError('validation', 'Le propriétaire ne peut pas être exclu de son espace');
        }
        await ctx.db.workspaceMembers.remove(input.userId, ctx.workspaceId);
        // Le favori de l'exclu pointait peut-être ici : sans ça, sa prochaine
        // connexion viserait un espace auquel il n'a plus accès.
        await clearFavoriteIfPointingAt(ctx, input.userId, ctx.workspaceId);
        invalidateAccess();
        ctx.audit({
            action: 'workspace.member.remove',
            level: 'warning',
            description: `Membre exclu de « ${ctx.workspace.name} »`,
            metadata: { removedUserId: input.userId }
        });
        return { userId: input.userId };
    }
});

export const workspaceInviteCreateFeature: FeatureDefinition<
    typeof workspaceInviteCreate.command,
    typeof workspaceInviteCreate.input,
    typeof workspaceInviteCreate.output
> = defineFeature({
    ...workspaceInviteCreate,
    handler: async (ctx, input) => {
        assertShared(ctx);
        assertOwner(ctx);
        const row = await ctx.db.workspaceInvites.create({
            workspaceId: ctx.workspaceId,
            createdBy: ctx.userId,
            ttlSeconds: input.ttlSeconds,
            maxUses: input.maxUses
        });
        ctx.audit({
            action: 'workspace.invite.create',
            level: 'warning',
            description: `Lien d’invitation créé pour « ${ctx.workspace.name} »`,
            metadata: { maxUses: input.maxUses, ttlSeconds: input.ttlSeconds }
        });
        const author = await ctx.db.users.findById(ctx.userId);
        return { invite: toInvite(row, author?.username ?? '') };
    }
});

export const workspaceInviteListFeature: FeatureDefinition<
    typeof workspaceInviteList.command,
    typeof workspaceInviteList.input,
    typeof workspaceInviteList.output
> = defineFeature({
    ...workspaceInviteList,
    handler: async (ctx) => {
        assertShared(ctx);
        assertOwner(ctx);
        const rows = await ctx.db.workspaceInvites.listActive(ctx.workspaceId);
        const authors = await ctx.db.users.findByIds(Array.from(new Set(rows.map((r) => r.created_by))));
        const nameOf = new Map(authors.map((u) => [u.id, u.username]));
        return { invites: rows.map((r) => toInvite(r, nameOf.get(r.created_by) ?? '')) };
    }
});

export const workspaceInviteRevokeFeature: FeatureDefinition<
    typeof workspaceInviteRevoke.command,
    typeof workspaceInviteRevoke.input,
    typeof workspaceInviteRevoke.output
> = defineFeature({
    ...workspaceInviteRevoke,
    handler: async (ctx, input) => {
        assertShared(ctx);
        assertOwner(ctx);
        const removed = await ctx.db.workspaceInvites.revoke(ctx.workspaceId, input.token);
        if (!removed) throw new FeatureError('not_found', 'Invitation introuvable');
        ctx.audit({
            action: 'workspace.invite.revoke',
            level: 'warning',
            description: `Lien d’invitation révoqué pour « ${ctx.workspace.name} »`
        });
        return { token: input.token };
    }
});

/**
 * Décrit une invitation sans la consommer.
 *
 * `scope: 'account'` est ici essentiel : celui qui suit le lien n'est pas encore
 * membre de l'espace visé, donc le résoudre depuis l'enveloppe échouerait avant
 * même d'atteindre le handler.
 */
export const workspaceInvitePreviewFeature: FeatureDefinition<
    typeof workspaceInvitePreview.command,
    typeof workspaceInvitePreview.input,
    typeof workspaceInvitePreview.output
> = defineFeature({
    ...workspaceInvitePreview,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const invite = await ctx.db.workspaceInvites.peek(input.token);
        if (!invite) throw new FeatureError('not_found', 'Invitation invalide ou expirée');
        const workspace = await ctx.db.workspaces.findById(invite.workspace_id);
        if (!workspace) throw new FeatureError('not_found', 'Espace introuvable');
        return {
            workspaceName: workspace.name,
            alreadyMember: await ctx.db.workspaceMembers.isMember(ctx.userId, workspace.id)
        };
    }
});

export const workspaceInviteAcceptFeature: FeatureDefinition<
    typeof workspaceInviteAccept.command,
    typeof workspaceInviteAccept.input,
    typeof workspaceInviteAccept.output
> = defineFeature({
    ...workspaceInviteAccept,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        // Déjà membre : ne pas brûler un usage du lien pour rien.
        const preview = await ctx.db.workspaceInvites.peek(input.token);
        if (!preview) throw new FeatureError('not_found', 'Invitation invalide ou expirée');
        if (await ctx.db.workspaceMembers.isMember(ctx.userId, preview.workspace_id)) {
            return { workspace: await describe(ctx, preview.workspace_id) };
        }

        const consumed = await ctx.db.workspaceInvites.consume(input.token);
        if (!consumed) throw new FeatureError('not_found', 'Invitation invalide ou expirée');

        await ctx.db.workspaceMembers.add({ userId: ctx.userId, workspaceId: consumed.workspaceId });
        invalidateAccess();

        const workspace = await describe(ctx, consumed.workspaceId);
        ctx.audit({
            action: 'workspace.invite.accept',
            level: 'warning',
            description: `Espace rejoint : « ${workspace.name} »`,
            metadata: { joinedWorkspaceId: workspace.id }
        });
        return { workspace };
    }
});

/** Un espace tel que le client l'attend, membres résolus. */
async function describe(ctx: FeatureContext, workspaceId: number): Promise<Workspace> {
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
            created: Number(u.created)
        })),
        features: parseFeatures(row.features),
        created: Number(row.created)
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
