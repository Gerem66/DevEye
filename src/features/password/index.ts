import {
    passwordAdd,
    passwordCount,
    passwordDelete,
    passwordEdit,
    passwordGet,
    passwordList,
    passwordUnlock
} from '@deveye/types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { encryptPayload, markUnlocked, toEntry, toMaskedEntry, tryDecryptPayload } from './_shared';

/**
 * Coffre de mots de passe, scopé à l'espace actif.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent simplement sur `ctx.workspaceId`, sans
 * garde ni traduction d'id.
 */

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
    access: { feature: 'password' },
    handler: async (ctx) => {
        // When password-based encryption is on, listing needs the DEK. Surface a
        // `locked` error (don't silently skip every row) so the client prompts.
        await assertSecureUnlocked(ctx);
        const rows = await ctx.db.passwords.listByWorkspace(ctx.workspaceId);
        // A single undecryptable row (a corrupt blob) must not break
        // the whole list — skip it with a warning instead of failing the feature.
        let skipped = 0;
        const entries = (
            await Promise.all(
                rows.map(async (r) => {
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
            ctx.logger.warn({ skipped, total: rows.length }, 'password.list: skipped undecryptable rows');
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
    access: { feature: 'password' },
    handler: async (ctx) => {
        // Pure row count from clear metadata: no DEK, no unlock gate. This lets
        // the dashboard widget show a number even when the store is locked.
        return { count: await ctx.db.passwords.countByWorkspace(ctx.workspaceId) };
    }
});

export const passwordGetFeature: FeatureDefinition<
    typeof passwordGet.command,
    typeof passwordGet.input,
    typeof passwordGet.output
> = defineFeature({
    ...passwordGet,
    access: { feature: 'password' },
    handler: async (ctx, input) => {
        await assertSecureUnlocked(ctx);
        const row = await ctx.db.passwords.findById(input.passwordId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Password not found');
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
    mutates: true,
    access: { feature: 'password', level: 'write' },
    handler: async (ctx, input) => {
        await assertSecureUnlocked(ctx);
        const content = await encryptPayload(ctx.secure, input.entry);
        const row = await ctx.db.passwords.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            content
        });
        ctx.audit({
            action: 'password.create',
            description: 'Mot de passe enregistré',
            metadata: { passwordId: row.id }
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
    mutates: true,
    access: { feature: 'password', level: 'write' },
    handler: async (ctx, input) => {
        await assertSecureUnlocked(ctx);
        const content = await encryptPayload(ctx.secure, input.entry);
        const updated = await ctx.db.passwords.update(input.entry.id, ctx.workspaceId, content);
        if (!updated) throw new FeatureError('not_found', 'Password not found');
        ctx.audit({
            action: 'password.edit',
            description: 'Mot de passe modifié',
            metadata: { passwordId: input.entry.id }
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
    mutates: true,
    access: { feature: 'password', level: 'write' },
    handler: async (ctx, input) => {
        const deleted = await ctx.db.passwords.delete(input.passwordId, ctx.workspaceId);
        if (!deleted) throw new FeatureError('not_found', 'Password not found');
        ctx.audit({
            action: 'password.delete',
            level: 'warning',
            description: 'Mot de passe supprimé',
            metadata: { passwordId: input.passwordId }
        });
        return { passwordId: input.passwordId };
    }
});

/**
 * Marque l'espace comme déverrouillé pour cette session.
 *
 * Être membre suffit : la protection réelle du contenu est le chiffrement
 * (`ctx.secure`), pas ce drapeau. L'ancien mot de passe par espace
 * (`workspaces.password_hash`) n'a jamais été renseigné — la colonne est
 * supprimée et cette commande n'échoue donc plus jamais.
 */
export const passwordUnlockFeature: FeatureDefinition<
    typeof passwordUnlock.command,
    typeof passwordUnlock.input,
    typeof passwordUnlock.output
> = defineFeature({
    ...passwordUnlock,
    access: { feature: 'password' },
    handler: async (ctx) => {
        markUnlocked(ctx.sessionId, ctx.workspaceId);
        return { unlocked: true as const };
    }
});
