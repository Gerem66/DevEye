import { verifyPassword } from '@/auth/argon';
import {
    passwordAdd,
    passwordDelete,
    passwordEdit,
    passwordGet,
    passwordList,
    passwordUnlock
} from 'deveye-types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    decryptPayload,
    encryptPayload,
    isUnlocked,
    markUnlocked,
    toEntry,
    toMaskedEntry
} from './_shared';

/**
 * Workspace id 0 is the caller's private/personal workspace: it has no row in
 * `workspaces`, no membership, and its items use `workspace_id = NULL`. The user
 * always owns it, so access is implicit.
 */
const PERSONAL_WORKSPACE_ID = 0;

async function assertWorkspaceMember(ctx: FeatureContext, workspaceId: number): Promise<void> {
    if (workspaceId === PERSONAL_WORKSPACE_ID) return;
    const ok = await ctx.db.workspaceMembers.isMember(ctx.userId, workspaceId);
    if (!ok) throw new FeatureError('forbidden', 'Not a member of this workspace');
}

/** Map a client workspace id to the DB column value (personal → NULL). */
function toDbWorkspaceId(workspaceId: number): number | null {
    return workspaceId === PERSONAL_WORKSPACE_ID ? null : workspaceId;
}

/** True when a stored row belongs to the given client workspace id. */
function rowInWorkspace(rowWorkspaceId: number | null, workspaceId: number): boolean {
    return (rowWorkspaceId ?? PERSONAL_WORKSPACE_ID) === workspaceId;
}

function assertUnlocked(ctx: FeatureContext, workspaceId: number): void {
    if (!isUnlocked(ctx.sessionId, workspaceId)) {
        throw new FeatureError('auth_required', 'Workspace locked; call password.unlock first');
    }
}

export const passwordListFeature: FeatureDefinition<
    typeof passwordList.command,
    typeof passwordList.input,
    typeof passwordList.output
> = defineFeature({
    ...passwordList,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const rows = await ctx.db.passwords.listByUser(ctx.userId);
        const filtered = rows.filter((r) => rowInWorkspace(r.workspace_id, input.workspaceId));
        const entries = filtered.map((r) => toMaskedEntry(r.id, decryptPayload(ctx.crypt, r.content)));
        return { entries };
    }
});

export const passwordGetFeature: FeatureDefinition<
    typeof passwordGet.command,
    typeof passwordGet.input,
    typeof passwordGet.output
> = defineFeature({
    ...passwordGet,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        assertUnlocked(ctx, input.workspaceId);
        const row = await ctx.db.passwords.findById(input.passwordId, ctx.userId);
        if (!row || !rowInWorkspace(row.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Password not found');
        }
        return { entry: toEntry(row.id, decryptPayload(ctx.crypt, row.content)) };
    }
});

export const passwordAddFeature: FeatureDefinition<
    typeof passwordAdd.command,
    typeof passwordAdd.input,
    typeof passwordAdd.output
> = defineFeature({
    ...passwordAdd,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        assertUnlocked(ctx, input.workspaceId);
        const content = encryptPayload(ctx.crypt, input.entry);
        const row = await ctx.db.passwords.create({
            userId: ctx.userId,
            workspaceId: toDbWorkspaceId(input.workspaceId),
            content
        });
        return { entry: toEntry(row.id, input.entry) };
    }
});

export const passwordEditFeature: FeatureDefinition<
    typeof passwordEdit.command,
    typeof passwordEdit.input,
    typeof passwordEdit.output
> = defineFeature({
    ...passwordEdit,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        assertUnlocked(ctx, input.workspaceId);
        const existing = await ctx.db.passwords.findById(input.entry.id, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Password not found');
        }
        const content = encryptPayload(ctx.crypt, input.entry);
        const updated = await ctx.db.passwords.update(input.entry.id, ctx.userId, content);
        if (!updated) throw new FeatureError('not_found', 'Password not found');
        return { entry: toEntry(updated.id, input.entry) };
    }
});

export const passwordDeleteFeature: FeatureDefinition<
    typeof passwordDelete.command,
    typeof passwordDelete.input,
    typeof passwordDelete.output
> = defineFeature({
    ...passwordDelete,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await ctx.db.passwords.findById(input.passwordId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Password not found');
        }
        await ctx.db.passwords.delete(input.passwordId, ctx.userId);
        return { passwordId: input.passwordId };
    }
});

export const passwordUnlockFeature: FeatureDefinition<
    typeof passwordUnlock.command,
    typeof passwordUnlock.input,
    typeof passwordUnlock.output
> = defineFeature({
    ...passwordUnlock,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        if (input.workspaceId === PERSONAL_WORKSPACE_ID) {
            // Personal workspace has no password; owning it is enough.
            markUnlocked(ctx.sessionId, input.workspaceId);
            return { unlocked: true as const };
        }
        const workspace = await ctx.db.workspaces.findById(input.workspaceId);
        if (!workspace) throw new FeatureError('not_found', 'Workspace not found');
        if (!workspace.password_hash) {
            // No workspace password set → consider it always unlocked.
            markUnlocked(ctx.sessionId, input.workspaceId);
            return { unlocked: true as const };
        }
        const ok = await verifyPassword(workspace.password_hash, input.password);
        if (!ok) throw new FeatureError('auth_invalid', 'Invalid workspace password');
        markUnlocked(ctx.sessionId, input.workspaceId);
        return { unlocked: true as const };
    }
});
