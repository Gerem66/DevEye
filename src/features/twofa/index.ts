import {
    twoFactorDisable,
    twoFactorEnable,
    twoFactorGetStatus,
    twoFactorRegenBackup,
    twoFactorSetup,
    type TwoFactorStatus
} from '@deveye/types';

import { sha256hex } from '@/Utils/hash';
import { generateBackupCodes, generateTotpSecret, normalizeBackupCode, verifyTotp } from '@/Services/Totp';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/*
 * The TOTP secret is an authentication-bound secret: it must be decryptable at
 * login (before any WS session / password unlock exists) to verify the 2FA
 * code. It is therefore sealed under the server key (`ctx.crypt.seal`) and does
 * NOT go through `ctx.secure` (the per-user DEK), unlike feature data at rest.
 */

async function buildStatus(ctx: FeatureContext): Promise<TwoFactorStatus> {
    const row = await ctx.db.twoFactor.get(ctx.userId);
    if (!row || !row.enabled) return { enabled: false, backupCodesRemaining: 0 };
    const remaining = await ctx.db.twoFactor.countUnusedBackupCodes(ctx.userId);
    return { enabled: true, backupCodesRemaining: remaining };
}

/** Verify a current TOTP or single-use backup code; throws on failure. */
async function assertValidCode(ctx: FeatureContext, code: string): Promise<void> {
    const row = await ctx.db.twoFactor.get(ctx.userId);
    if (!row || !row.enabled) throw new FeatureError('conflict', '2FA is not enabled');
    const secret = ctx.crypt.open(row.secret_enc);
    if (secret && verifyTotp(code.trim(), secret)) return;
    const backup = await ctx.db.twoFactor.findUnusedBackupCode(ctx.userId, sha256hex(normalizeBackupCode(code)));
    if (backup) {
        await ctx.db.twoFactor.markBackupCodeUsed(backup.id);
        return;
    }
    throw new FeatureError('auth_invalid', 'Invalid 2FA code');
}

export const twoFactorStatusFeature: FeatureDefinition<
    typeof twoFactorGetStatus.command,
    typeof twoFactorGetStatus.input,
    typeof twoFactorGetStatus.output
> = defineFeature({
    ...twoFactorGetStatus,
    access: { scope: 'account' },
    handler: async (ctx) => ({ status: await buildStatus(ctx) })
});

export const twoFactorSetupFeature: FeatureDefinition<
    typeof twoFactorSetup.command,
    typeof twoFactorSetup.input,
    typeof twoFactorSetup.output
> = defineFeature({
    ...twoFactorSetup,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx) => {
        const existing = await ctx.db.twoFactor.get(ctx.userId);
        if (existing?.enabled) throw new FeatureError('conflict', '2FA is already enabled');

        const user = await ctx.db.users.findById(ctx.userId);
        const account = user?.email ?? `user-${ctx.userId}`;
        const { secret, otpauthUrl } = generateTotpSecret(account);
        const backupCodes = generateBackupCodes();

        await ctx.db.twoFactor.upsertSecret(ctx.userId, ctx.crypt.seal(secret));
        await ctx.db.twoFactor.replaceBackupCodes(
            ctx.userId,
            backupCodes.map((c) => sha256hex(normalizeBackupCode(c)))
        );

        ctx.audit({ action: 'twofa.setup', description: 'Configuration 2FA initiée (secret + codes générés)' });
        return { setup: { secret, otpauthUrl, backupCodes } };
    }
});

export const twoFactorEnableFeature: FeatureDefinition<
    typeof twoFactorEnable.command,
    typeof twoFactorEnable.input,
    typeof twoFactorEnable.output
> = defineFeature({
    ...twoFactorEnable,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const row = await ctx.db.twoFactor.get(ctx.userId);
        if (!row) throw new FeatureError('conflict', 'Start 2FA setup first');
        if (row.enabled) throw new FeatureError('conflict', '2FA is already enabled');
        const secret = ctx.crypt.open(row.secret_enc);
        if (!secret || !verifyTotp(input.code.trim(), secret)) {
            throw new FeatureError('auth_invalid', 'Invalid TOTP code');
        }
        await ctx.db.twoFactor.enable(ctx.userId);
        ctx.audit({ action: 'twofa.enable', level: 'warning', description: 'Double authentification activée' });
        return { status: await buildStatus(ctx) };
    }
});

export const twoFactorDisableFeature: FeatureDefinition<
    typeof twoFactorDisable.command,
    typeof twoFactorDisable.input,
    typeof twoFactorDisable.output
> = defineFeature({
    ...twoFactorDisable,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        await assertValidCode(ctx, input.code);
        await ctx.db.twoFactor.disable(ctx.userId);
        ctx.audit({ action: 'twofa.disable', level: 'warning', description: 'Double authentification désactivée' });
        return { status: await buildStatus(ctx) };
    }
});

export const twoFactorRegenBackupFeature: FeatureDefinition<
    typeof twoFactorRegenBackup.command,
    typeof twoFactorRegenBackup.input,
    typeof twoFactorRegenBackup.output
> = defineFeature({
    ...twoFactorRegenBackup,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx) => {
        const row = await ctx.db.twoFactor.get(ctx.userId);
        if (!row || !row.enabled) throw new FeatureError('conflict', '2FA is not enabled');
        const backupCodes = generateBackupCodes();
        await ctx.db.twoFactor.replaceBackupCodes(
            ctx.userId,
            backupCodes.map((c) => sha256hex(normalizeBackupCode(c)))
        );
        ctx.audit({
            action: 'twofa.regenBackup',
            level: 'warning',
            description: 'Codes de secours 2FA régénérés'
        });
        return { backupCodes };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const twoFactorFeatures: FeatureDefinition<string, any, any>[] = [
    twoFactorStatusFeature,
    twoFactorSetupFeature,
    twoFactorEnableFeature,
    twoFactorDisableFeature,
    twoFactorRegenBackupFeature
];
