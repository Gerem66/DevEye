import {
    secrecyDisable,
    secrecyEnable,
    secrecyRecover,
    secrecyStatus,
    secrecyUnlock,
    type SecrecyStatus
} from 'deveye-types';

import { hashPassword, verifyPassword } from '@/auth/argon';
import { WrongSecretError } from '@/Services/SecretKeyService';
import { rememberSessionDek } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/** Build the status payload from the user's secret-key row + session state. */
async function buildStatus(ctx: FeatureContext): Promise<SecrecyStatus> {
    const row = await ctx.secretKeys.ensureRow(ctx.userId);
    const enabled = ctx.secretKeys.isPasswordWrapped(row);
    return {
        enabled,
        unlocked: await ctx.secure.isUnlockedPassive(),
        recoveryEnabled: row.recovery_wrapped !== null
    };
}

/** Verify the account password hash; throws a clean error on mismatch. */
async function assertAccountPassword(ctx: FeatureContext, password: string): Promise<void> {
    const user = await ctx.db.users.findById(ctx.userId);
    if (!user?.password_hash || !(await verifyPassword(user.password_hash, password))) {
        throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
    }
}

export const secrecyStatusFeature: FeatureDefinition<
    typeof secrecyStatus.command,
    typeof secrecyStatus.input,
    typeof secrecyStatus.output
> = defineFeature({
    ...secrecyStatus,
    handler: async (ctx) => ({ status: await buildStatus(ctx) })
});

export const secrecyUnlockFeature: FeatureDefinition<
    typeof secrecyUnlock.command,
    typeof secrecyUnlock.input,
    typeof secrecyUnlock.output
> = defineFeature({
    ...secrecyUnlock,
    handler: async (ctx, input) => {
        const row = await ctx.secretKeys.ensureRow(ctx.userId);
        if (!ctx.secretKeys.isPasswordWrapped(row)) {
            // Nothing to unlock — server-wrapped data is always accessible.
            return { status: await buildStatus(ctx) };
        }
        let dek;
        try {
            dek = await ctx.secretKeys.unwrapWithPassword(row, input.password);
        } catch (e) {
            if (e instanceof WrongSecretError) throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
            throw e;
        }
        rememberSessionDek(ctx.sessionId, dek);
        return { status: await buildStatus(ctx) };
    }
});

export const secrecyEnableFeature: FeatureDefinition<
    typeof secrecyEnable.command,
    typeof secrecyEnable.input,
    typeof secrecyEnable.output
> = defineFeature({
    ...secrecyEnable,
    handler: async (ctx, input) => {
        await assertAccountPassword(ctx, input.password);
        const row = await ctx.secretKeys.ensureRow(ctx.userId);
        if (ctx.secretKeys.isPasswordWrapped(row)) {
            throw new FeatureError('conflict', 'Le chiffrement par mot de passe est déjà activé');
        }

        // Feature currently OFF → the DEK is server-wrapped and readable here.
        const dek = ctx.secretKeys.resolveServerDek(row);
        const { recoveryCode } = await ctx.secretKeys.wrapWithPassword(
            ctx.userId,
            dek,
            input.password,
            input.recovery ? 'generate' : 'none',
            row
        );

        // Keep the session unlocked so the user isn't immediately prompted.
        rememberSessionDek(ctx.sessionId, dek);
        ctx.secure.invalidate();
        return { status: await buildStatus(ctx), recoveryCode };
    }
});

export const secrecyDisableFeature: FeatureDefinition<
    typeof secrecyDisable.command,
    typeof secrecyDisable.input,
    typeof secrecyDisable.output
> = defineFeature({
    ...secrecyDisable,
    handler: async (ctx, input) => {
        const row = await ctx.secretKeys.ensureRow(ctx.userId);
        if (!ctx.secretKeys.isPasswordWrapped(row)) {
            throw new FeatureError('conflict', "Le chiffrement par mot de passe n'est pas activé");
        }
        // The password itself must unwrap the DEK — proves the user can read
        // their own data before we hand it back to the server key.
        let dek;
        try {
            dek = await ctx.secretKeys.unwrapWithPassword(row, input.password);
        } catch (e) {
            if (e instanceof WrongSecretError) throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
            throw e;
        }
        await ctx.secretKeys.wrapWithServer(ctx.userId, dek);
        rememberSessionDek(ctx.sessionId, dek);
        ctx.secure.invalidate();
        return { status: await buildStatus(ctx) };
    }
});

export const secrecyRecoverFeature: FeatureDefinition<
    typeof secrecyRecover.command,
    typeof secrecyRecover.input,
    typeof secrecyRecover.output
> = defineFeature({
    ...secrecyRecover,
    handler: async (ctx, input) => {
        const row = await ctx.secretKeys.ensureRow(ctx.userId);
        if (!ctx.secretKeys.isPasswordWrapped(row) || row.recovery_wrapped === null) {
            throw new FeatureError('conflict', 'Aucun code de récupération configuré');
        }
        let dek;
        try {
            dek = await ctx.secretKeys.unwrapWithRecovery(row, input.recoveryCode);
        } catch (e) {
            if (e instanceof WrongSecretError) throw new FeatureError('auth_invalid', 'Code de récupération invalide');
            throw e;
        }
        // Recovery is effectively a password reset: re-wrap the DEK with the new
        // password and align the account password hash so login keeps working.
        await ctx.secretKeys.wrapWithPassword(ctx.userId, dek, input.newPassword, 'keep', row);
        await ctx.db.users.updatePasswordHash(ctx.userId, await hashPassword(input.newPassword));
        rememberSessionDek(ctx.sessionId, dek);
        ctx.secure.invalidate();
        return { status: await buildStatus(ctx) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const secrecyFeatures: FeatureDefinition<string, any, any>[] = [
    secrecyStatusFeature,
    secrecyUnlockFeature,
    secrecyEnableFeature,
    secrecyDisableFeature,
    secrecyRecoverFeature
];
