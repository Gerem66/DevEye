import {
    WORKSPACE_CAPABILITIES,
    WORKSPACE_FEATURE_IDS,
    workspaceAssignRole,
    workspaceRoleCreate,
    workspaceRoleDelete,
    workspaceRoleList,
    workspaceRoleSetDefault,
    workspaceRoleUpdate
} from 'deveye-types';
import type { WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRole, WorkspaceRoleRow } from 'deveye-types';

import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Rôles d'un espace : le paramétrage des droits.
 *
 * Un espace personnel n'en a pas — son propriétaire y est seul et peut tout.
 * Créer des rôles y serait un réglage sans objet.
 */
function assertShared(ctx: FeatureContext): void {
    if (ctx.workspace.kind === 'personal') {
        throw new FeatureError('validation', 'L’espace personnel n’a pas de rôles');
    }
}

async function toRole(ctx: FeatureContext, row: WorkspaceRoleRow): Promise<WorkspaceRole> {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        position: row.position,
        capabilities: parse<WorkspaceCapability>(row.capabilities),
        features: parse<WorkspaceFeatureGrant>(row.features),
        isDefault: Number(row.is_default) === 1,
        memberCount: await ctx.db.workspaceRoles.memberCount(row.id)
    };
}

function parse<T>(raw: unknown): T[] {
    if (Array.isArray(raw)) return raw as T[];
    if (typeof raw === 'string') {
        try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? (p as T[]) : [];
        } catch {
            return [];
        }
    }
    return [];
}

export const workspaceRoleListFeature: FeatureDefinition<
    typeof workspaceRoleList.command,
    typeof workspaceRoleList.input,
    typeof workspaceRoleList.output
> = defineFeature({
    ...workspaceRoleList,
    handler: async (ctx) => {
        // Volontairement sans capacité requise : tout membre a besoin de
        // connaître ses propres droits pour que l'interface s'y conforme. La
        // liste des rôles n'est pas un secret, leur modification l'est.
        const rows =
            ctx.workspace.kind === 'personal' ? [] : await ctx.db.workspaceRoles.listByWorkspace(ctx.workspaceId);
        return {
            roles: await Promise.all(rows.map((r) => toRole(ctx, r))),
            memberRoles:
                ctx.workspace.kind === 'personal' ? [] : await ctx.db.workspaceRoles.memberRoles(ctx.workspaceId),
            permissions: {
                isOwner: ctx.isOwner,
                capabilities: WORKSPACE_CAPABILITIES.filter((c) => ctx.can(c)),
                features: WORKSPACE_FEATURE_IDS.flatMap<WorkspaceFeatureGrant>((f) => {
                    if (ctx.canFeature(f, 'write')) return [{ feature: f, access: 'write' }];
                    if (ctx.canFeature(f)) return [{ feature: f, access: 'read' }];
                    return [];
                })
            }
        };
    }
});

export const workspaceRoleCreateFeature: FeatureDefinition<
    typeof workspaceRoleCreate.command,
    typeof workspaceRoleCreate.input,
    typeof workspaceRoleCreate.output
> = defineFeature({
    ...workspaceRoleCreate,
    mutates: true,
    access: { capabilities: ['workspace.roles'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const row = await ctx.db.workspaceRoles.create(ctx.workspaceId, {
            name: input.name.trim(),
            color: input.color,
            capabilities: input.capabilities,
            features: input.features
        });
        ctx.audit({ action: 'workspace.role.create', description: `Rôle créé : « ${row.name} »` });
        return { role: await toRole(ctx, row) };
    }
});

export const workspaceRoleUpdateFeature: FeatureDefinition<
    typeof workspaceRoleUpdate.command,
    typeof workspaceRoleUpdate.input,
    typeof workspaceRoleUpdate.output
> = defineFeature({
    ...workspaceRoleUpdate,
    mutates: true,
    // Identité et droits d'un rôle relèvent de la même capacité : c'est le
    // choix qui garde UN écran et UNE règle. Le découpage plus fin (identité vs
    // contenu, `workspace.permissions`) a été essayé puis retiré — deux
    // capacités pour un même formulaire produisaient des demi-refus illisibles.
    access: { capabilities: ['workspace.roles'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const row = await ctx.db.workspaceRoles.update(input.roleId, ctx.workspaceId, {
            name: input.name.trim(),
            color: input.color,
            capabilities: input.capabilities,
            features: input.features
        });
        if (!row) throw new FeatureError('not_found', 'Rôle introuvable');

        // Les droits de tous ceux qui portent ce rôle viennent de changer.
        invalidateAccess();
        await ctx.live?.resync(ctx.db, ctx.workspaceId);

        ctx.audit({
            action: 'workspace.role.update',
            level: 'warning',
            description: `Rôle modifié : « ${row.name} »`
        });
        return { role: await toRole(ctx, row) };
    }
});

export const workspaceRoleDeleteFeature: FeatureDefinition<
    typeof workspaceRoleDelete.command,
    typeof workspaceRoleDelete.input,
    typeof workspaceRoleDelete.output
> = defineFeature({
    ...workspaceRoleDelete,
    mutates: true,
    access: { capabilities: ['workspace.roles'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const row = await ctx.db.workspaceRoles.findById(input.roleId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Rôle introuvable');

        // Refus explicite plutôt qu'une révocation en cascade : supprimer un rôle
        // porté retirerait silencieusement l'accès à ses membres. La FK est en
        // `SET NULL` pour ne pas gêner la suppression d'un espace entier, donc
        // rien ne l'empêche au niveau base — c'est ici que ça se joue.
        const members = await ctx.db.workspaceRoles.memberCount(row.id);
        if (members > 0) {
            throw new FeatureError(
                'conflict',
                `${members} membre(s) portent ce rôle. Attribuez-leur un autre rôle avant de le supprimer.`
            );
        }

        await ctx.db.workspaceRoles.delete(row.id, ctx.workspaceId);
        ctx.audit({
            action: 'workspace.role.delete',
            level: 'warning',
            description: `Rôle supprimé : « ${row.name} »`
        });
        return { roleId: row.id };
    }
});

export const workspaceRoleSetDefaultFeature: FeatureDefinition<
    typeof workspaceRoleSetDefault.command,
    typeof workspaceRoleSetDefault.input,
    typeof workspaceRoleSetDefault.output
> = defineFeature({
    ...workspaceRoleSetDefault,
    mutates: true,
    access: { capabilities: ['workspace.roles'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        const row = await ctx.db.workspaceRoles.findById(input.roleId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Rôle introuvable');
        await ctx.db.workspaceRoles.setDefault(ctx.workspaceId, row.id);
        ctx.audit({
            action: 'workspace.role.setDefault',
            description: `Rôle par défaut : « ${row.name} »`
        });
        return { roleId: row.id };
    }
});

export const workspaceAssignRoleFeature: FeatureDefinition<
    typeof workspaceAssignRole.command,
    typeof workspaceAssignRole.input,
    typeof workspaceAssignRole.output
> = defineFeature({
    ...workspaceAssignRole,
    mutates: true,
    access: { capabilities: ['workspace.members'] },
    handler: async (ctx, input) => {
        assertShared(ctx);
        if (input.userId === ctx.workspace.ownerUserId) {
            throw new FeatureError(
                'validation',
                'Le propriétaire a tous les droits par construction : lui attribuer un rôle n’aurait aucun effet.'
            );
        }
        if (!(await ctx.db.workspaceMembers.isMember(input.userId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Ce compte n’est pas membre de l’espace');
        }
        if (input.roleId !== null && !(await ctx.db.workspaceRoles.findById(input.roleId, ctx.workspaceId))) {
            throw new FeatureError('not_found', 'Rôle introuvable');
        }

        await ctx.db.workspaceRoles.assign(input.userId, ctx.workspaceId, input.roleId);
        invalidateAccess();
        await ctx.live?.resync(ctx.db, ctx.workspaceId);

        ctx.audit({
            action: 'workspace.member.setRole',
            level: 'warning',
            description: input.roleId === null ? 'Rôle retiré à un membre' : 'Rôle attribué à un membre',
            metadata: { targetUserId: input.userId, roleId: input.roleId }
        });
        return { userId: input.userId, roleId: input.roleId };
    }
});
