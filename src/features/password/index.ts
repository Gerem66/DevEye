import { verifyPassword } from '@/auth/argon';
import {
    passwordAdd,
    passwordCount,
    passwordDelete,
    passwordEdit,
    passwordGet,
    passwordList,
    passwordUnlock
} from 'deveye-types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { encryptPayload, markUnlocked, toEntry, toMaskedEntry, tryDecryptPayload } from './_shared';

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

/**
 * Ensure the password-based encryption DEK is available this session. No-op
 * when the feature is off; throws `locked` (client prompts for the password)
 * when it's on but the session hasn't been unlocked yet.
 */
async function assertSecureUnlocked(ctx: FeatureContext): Promise<void> {
    try {
        if (!(await ctx.secure.isUnlocked())) {
            throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
        }
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        // DB/infra error (e.g. migration not yet applied) — let through rather
        // than masking all passwords as locked.
        ctx.logger.warn({ err: e }, 'assertSecureUnlocked: failed to check lock state, assuming unlocked');
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
        // When password-based encryption is on, listing needs the DEK. Surface a
        // `locked` error (don't silently skip every row) so the client prompts.
        await assertSecureUnlocked(ctx);
        const rows = await ctx.db.passwords.listByUser(ctx.userId);
        const filtered = rows.filter((r) => rowInWorkspace(r.workspace_id, input.workspaceId));
        // A single undecryptable row (e.g. legacy/foreign-key data) must not break
        // the whole list — skip it with a warning instead of failing the feature.
        let skipped = 0;
        const entries = (
            await Promise.all(
                filtered.map(async (r) => {
                    const payload = await tryDecryptPayload(ctx.secure, r.content);
                    if (!payload) {
                        skipped += 1;
                        return null;
                    }
                    return toMaskedEntry(r.id, payload);
                })
            )
        ).filter((e): e is NonNullable<typeof e> => e !== null);
        if (skipped > 0) {
            ctx.logger.warn({ skipped, total: filtered.length }, 'password.list: skipped undecryptable rows');
        }
        return { entries };
    }
});

export const passwordCountFeature: FeatureDefinition<
    typeof passwordCount.command,
    typeof passwordCount.input,
    typeof passwordCount.output
> = defineFeature({
    ...passwordCount,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        // Pure row count from clear metadata: no DEK, no unlock gate. This lets
        // the dashboard widget show a number even when the store is locked.
        const rows = await ctx.db.passwords.listByUser(ctx.userId);
        const count = rows.filter((r) => rowInWorkspace(r.workspace_id, input.workspaceId)).length;
        return { count };
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
        await assertSecureUnlocked(ctx);
        const row = await ctx.db.passwords.findById(input.passwordId, ctx.userId);
        if (!row || !rowInWorkspace(row.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Password not found');
        }
        const payload = await tryDecryptPayload(ctx.secure, row.content);
        if (!payload) throw new FeatureError('internal', 'Failed to decrypt password content');
        return { entry: toEntry(row.id, payload) };
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
        await assertSecureUnlocked(ctx);
        const content = await encryptPayload(ctx.secure, input.entry);
        const row = await ctx.db.passwords.create({
            userId: ctx.userId,
            workspaceId: toDbWorkspaceId(input.workspaceId),
            content
        });
        ctx.audit({
            action: 'password.create',
            description: 'Mot de passe enregistré',
            metadata: { passwordId: row.id, workspaceId: input.workspaceId }
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
        await assertSecureUnlocked(ctx);
        const existing = await ctx.db.passwords.findById(input.entry.id, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Password not found');
        }
        const content = await encryptPayload(ctx.secure, input.entry);
        const updated = await ctx.db.passwords.update(input.entry.id, ctx.userId, content);
        if (!updated) throw new FeatureError('not_found', 'Password not found');
        ctx.audit({
            action: 'password.edit',
            description: 'Mot de passe modifié',
            metadata: { passwordId: input.entry.id, workspaceId: input.workspaceId }
        });
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
        ctx.audit({
            action: 'password.delete',
            level: 'warning',
            description: 'Mot de passe supprimé',
            metadata: { passwordId: input.passwordId, workspaceId: input.workspaceId }
        });
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
        if (!ok) {
            ctx.audit({
                action: 'password.unlock_failed',
                level: 'warning',
                description: 'Échec de déverrouillage : mot de passe d’espace incorrect',
                metadata: { workspaceId: input.workspaceId }
            });
            throw new FeatureError('auth_invalid', 'Invalid workspace password');
        }
        markUnlocked(ctx.sessionId, input.workspaceId);
        ctx.audit({
            action: 'password.unlock',
            description: 'Espace de mots de passe déverrouillé',
            metadata: { workspaceId: input.workspaceId }
        });
        return { unlocked: true as const };
    }
});
