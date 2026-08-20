import { workspaceLeave, workspaceAddMember, workspaceRemoveMember, workspaceRename } from 'deveye-types';
import type { Workspace } from 'deveye-types';

import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Gestion des membres d'un espace.
 *
 * Les droits ne sont plus « propriétaire ou rien » : ils passent par les
 * capacités `workspace.members` (ajouter, exclure) et `workspace.manage`
 * (renommer, supprimer), déclarées sur chaque commande et appliquées par le
 * dispatcheur. Le propriétaire les possède toutes d'office.
 *
 * On rejoint un espace parce qu'un membre vous y met, jamais parce qu'on
 * détient un lien : l'inscription étant déjà sur invitation d'un
 * administrateur, tout compte candidat existe et une adresse suffit à le
 * désigner. Un jeton d'invitation n'aurait fait qu'ajouter un secret
 * transmissible, à expirer et à révoquer, pour le même résultat.
 */

/** Un espace personnel n'a pas de membres : il est personnel. */
function assertShared(ctx: FeatureContext): void {
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
        return { workspace: await describe(ctx, ctx.workspaceId) };
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
        await ctx.db.workspaceMembers.remove(ctx.userId, ctx.workspaceId);
        await clearFavoriteIfPointingAt(ctx, ctx.userId, ctx.workspaceId);
        invalidateAccess();
        ctx.live?.evict(ctx.workspaceId, ctx.userId);
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
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        if (input.userId === ctx.workspace.ownerUserId) {
            throw new FeatureError('validation', 'Le propriétaire ne peut pas être exclu de son espace');
        }
        await ctx.db.workspaceMembers.remove(input.userId, ctx.workspaceId);
        // Le favori de l'exclu pointait peut-être ici : sans ça, sa prochaine
        // connexion viserait un espace auquel il n'a plus accès.
        await clearFavoriteIfPointingAt(ctx, input.userId, ctx.workspaceId);
        invalidateAccess();
        ctx.live?.evict(ctx.workspaceId, input.userId);
        // Miroir de l'ajout : assis dans un autre espace, l'exclu ne recevrait
        // pas la diffusion de celui-ci, et l'entrée resterait dans son menu.
        ctx.live?.userChanged(input.userId, ctx.workspaceId, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.remove',
            level: 'warning',
            description: `Membre exclu de « ${ctx.workspace.name} »`,
            metadata: { removedUserId: input.userId }
        });
        return { userId: input.userId };
    }
});

export const workspaceAddMemberFeature: FeatureDefinition<
    typeof workspaceAddMember.command,
    typeof workspaceAddMember.input,
    typeof workspaceAddMember.output
> = defineFeature({
    ...workspaceAddMember,
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const email = input.email.trim().toLowerCase();
        const target = await ctx.db.users.findByEmail(email);
        // L'inscription est sur invitation d'un administrateur : on ne crée pas
        // de compte ici. Le dire explicitement vaut mieux qu'un échec muet — la
        // personne qui ajoute saura qu'il faut d'abord faire créer le compte.
        if (!target) {
            throw new FeatureError('not_found', 'Aucun compte DevEye avec cette adresse');
        }
        if (target.status === 'suspended') {
            throw new FeatureError('validation', 'Ce compte est suspendu');
        }
        if (await ctx.db.workspaceMembers.isMember(target.id, ctx.workspaceId)) {
            throw new FeatureError('conflict', `« ${target.username} » est déjà membre de cet espace`);
        }

        await ctx.db.workspaceMembers.add({ userId: target.id, workspaceId: ctx.workspaceId });

        // Sans rôle, un nouvel arrivant n'aurait aucun droit : la résolution est
        // fail-closed. Le rôle par défaut de l'espace est donc attribué d'office.
        // S'il n'y en a pas, le membre entre sans droits — visible et corrigeable
        // depuis l'onglet Membres, plutôt qu'un accès accordé par défaut.
        const fallback = await ctx.db.workspaceRoles.findDefault(ctx.workspaceId);
        if (fallback) {
            await ctx.db.workspaceRoles.assign(target.id, ctx.workspaceId, fallback.id);
        }

        invalidateAccess();
        // L'arrivant, lui, n'est PAS dans la salle de cet espace : la diffusion
        // ordinaire ne l'atteint pas. S'il est connecté ailleurs, on le vise par
        // compte pour que l'espace apparaisse dans son menu sans rechargement.
        ctx.live?.userChanged(target.id, ctx.workspaceId, ['workspace'], ctx.userId);
        ctx.audit({
            action: 'workspace.member.add',
            level: 'warning',
            description: `« ${target.username} » ajouté à « ${ctx.workspace.name} »`,
            metadata: { addedUserId: target.id }
        });
        return { workspace: await describe(ctx, ctx.workspaceId) };
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
            color: u.color,
            lastLogin: Number(u.last_login),
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
