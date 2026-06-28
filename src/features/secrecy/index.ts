import {
    secrecyDisable,
    secrecyEnable,
    secrecyHold,
    secrecyLock,
    secrecyRecover,
    secrecySetReauth,
    secrecyStatus,
    secrecyTouch,
    secrecyUnlock,
    type SecrecyStatus
} from 'deveye-types';

import { hashPassword, verifyPassword } from '@/auth/argon';
import { WrongSecretError } from '@/Services/SecretKeyService';
import {
    DEFAULT_DEK_GRACE_MS,
    forgetSessionDek,
    holdSessionDek,
    peekDekExpiry,
    rememberSessionDek,
    touchSessionDek
} from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * The user's configured re-validation interval in seconds, or `null` when unset.
 * `null` falls back to the server default at unlock time; `0` disables caching.
 */
async function reAuthInterval(ctx: FeatureContext): Promise<number | null> {
    const user = await ctx.db.users.findById(ctx.userId);
    return user?.re_auth_interval ?? null;
}

/** Grace window in ms to hand to {@link rememberSessionDek} for this user. */
async function graceMs(ctx: FeatureContext): Promise<number> {
    const seconds = await reAuthInterval(ctx);
    return seconds === null ? DEFAULT_DEK_GRACE_MS : seconds * 1000;
}

/** Build the status payload from the user's secret-key row + session state. */
async function buildStatus(ctx: FeatureContext): Promise<SecrecyStatus> {
    const row = await ctx.secretKeys.ensureRow(ctx.userId);
    const enabled = ctx.secretKeys.isPasswordWrapped(row);
    return {
        enabled,
        unlocked: await ctx.secure.isUnlockedPassive(),
        recoveryEnabled: row.recovery_wrapped !== null,
        reAuthInterval: await reAuthInterval(ctx),
        // Only meaningful while the feature is on and the session is unlocked with
        // a real (non single-use) cached DEK; null otherwise (see peekDekExpiry).
        unlockedUntil: enabled ? peekDekExpiry(ctx.sessionId) : null
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
        rememberSessionDek(ctx.sessionId, dek, await graceMs(ctx));
        ctx.audit({ action: 'secrecy.unlock', description: 'Coffre chiffré déverrouillé pour la session' });
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

        // Keep the session unlocked so the user isn't immediately prompted
        // (unless their window is 0, in which case rememberSessionDek wipes it).
        rememberSessionDek(ctx.sessionId, dek, await graceMs(ctx));
        ctx.secure.invalidate();
        ctx.audit({
            action: 'secrecy.enable',
            level: 'warning',
            description: 'Chiffrement par mot de passe activé',
            metadata: { recovery: Boolean(input.recovery) }
        });
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
        rememberSessionDek(ctx.sessionId, dek, await graceMs(ctx));
        ctx.secure.invalidate();
        ctx.audit({
            action: 'secrecy.disable',
            level: 'warning',
            description: 'Chiffrement par mot de passe désactivé'
        });
        return { status: await buildStatus(ctx) };
    }
});

export const secrecySetReauthFeature: FeatureDefinition<
    typeof secrecySetReauth.command,
    typeof secrecySetReauth.input,
    typeof secrecySetReauth.output
> = defineFeature({
    ...secrecySetReauth,
    handler: async (ctx, input) => {
        // Persist the new window. We don't reset the current session's live DEK:
        // the new value takes effect on the next unlock/access, which keeps the
        // change non-disruptive while the user is mid-session.
        await ctx.db.users.setReAuthInterval(ctx.userId, input.seconds);
        ctx.audit({
            action: 'secrecy.setReauth',
            description: 'Fenêtre de re-validation du mot de passe modifiée',
            metadata: { seconds: input.seconds }
        });
        return { status: await buildStatus(ctx) };
    }
});

export const secrecyHoldFeature: FeatureDefinition<
    typeof secrecyHold.command,
    typeof secrecyHold.input,
    typeof secrecyHold.output
> = defineFeature({
    ...secrecyHold,
    handler: async (ctx, input) => {
        // Heartbeat from an open action popup: pin (or release) the cached DEK so a
        // long edit can't trip the re-validation prompt mid-action. A no-op when
        // locked / feature off (nothing cached to hold), so it's always safe to send.
        holdSessionDek(ctx.sessionId, input.active, await graceMs(ctx));
        return { status: await buildStatus(ctx) };
    }
});

export const secrecyTouchFeature: FeatureDefinition<
    typeof secrecyTouch.command,
    typeof secrecyTouch.input,
    typeof secrecyTouch.output
> = defineFeature({
    ...secrecyTouch,
    handler: async (ctx) => {
        // Manual "postpone the flush" from the topbar timer widget.
        touchSessionDek(ctx.sessionId);
        return { status: await buildStatus(ctx) };
    }
});

export const secrecyLockFeature: FeatureDefinition<
    typeof secrecyLock.command,
    typeof secrecyLock.input,
    typeof secrecyLock.output
> = defineFeature({
    ...secrecyLock,
    handler: async (ctx) => {
        // Manual re-lock from the topbar widget: drop the cached DEK now so the
        // next encrypted action re-prompts. No-op when nothing is cached.
        forgetSessionDek(ctx.sessionId);
        ctx.audit({ action: 'secrecy.lock', description: 'Coffre chiffré re-verrouillé manuellement' });
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
        rememberSessionDek(ctx.sessionId, dek, await graceMs(ctx));
        ctx.secure.invalidate();
        ctx.audit({
            action: 'secrecy.recover',
            level: 'warning',
            description: 'Récupération par code : mot de passe réinitialisé'
        });
        return { status: await buildStatus(ctx) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const secrecyFeatures: FeatureDefinition<string, any, any>[] = [
    secrecyStatusFeature,
    secrecyUnlockFeature,
    secrecyEnableFeature,
    secrecyDisableFeature,
    secrecySetReauthFeature,
    secrecyHoldFeature,
    secrecyTouchFeature,
    secrecyLockFeature,
    secrecyRecoverFeature
];
