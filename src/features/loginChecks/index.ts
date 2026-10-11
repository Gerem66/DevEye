import {
    loginChecksForgetBrowser,
    loginChecksForgetBrowsers,
    loginChecksSetEmail,
    loginChecksStatus,
    type LoginChecksStatus
} from '@deveye/types';

import { maskEmail } from '@/auth/mask';
import { serverMail } from '@/Services/serverMail';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertAccountPassword } from '../_password';

async function buildStatus(ctx: FeatureContext): Promise<LoginChecksStatus> {
    const user = await ctx.db.users.findById(ctx.userId);
    if (!user) throw new FeatureError('not_found', 'Compte introuvable');
    const browsers = await ctx.db.trustedBrowsers.listByUser(ctx.userId, Math.floor(Date.now() / 1000));
    return {
        email: {
            available: serverMail.configured,
            enabled: user.login_email_check === 1,
            to: maskEmail(user.email)
        },
        browsers: browsers.map((b) => ({
            id: Number(b.id),
            label: b.label,
            createdAt: Number(b.created_at),
            lastUsedAt: Number(b.last_used_at)
        }))
    };
}

export const loginChecksStatusFeature: FeatureDefinition<
    typeof loginChecksStatus.command,
    typeof loginChecksStatus.input,
    typeof loginChecksStatus.output
> = defineFeature({
    ...loginChecksStatus,
    access: { scope: 'account' },
    handler: async (ctx) => ({ status: await buildStatus(ctx) })
});

export const loginChecksSetEmailFeature: FeatureDefinition<
    typeof loginChecksSetEmail.command,
    typeof loginChecksSetEmail.input,
    typeof loginChecksSetEmail.output
> = defineFeature({
    ...loginChecksSetEmail,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        if (!input.enabled) {
            // Baisser la garde de la prochaine connexion : une session volée ne le fait pas seule.
            if (!input.password) throw new FeatureError('validation', 'Mot de passe requis');
            await assertAccountPassword(ctx, input.password, 'loginChecks.setEmail_failed');
        }
        await ctx.db.users.setLoginEmailCheck(ctx.userId, input.enabled);
        ctx.audit({
            action: 'loginChecks.setEmail',
            level: input.enabled ? 'info' : 'warning',
            description: input.enabled
                ? 'Code par mail aux connexions depuis un nouveau navigateur : activé'
                : 'Code par mail aux connexions depuis un nouveau navigateur : désactivé'
        });
        return { status: await buildStatus(ctx) };
    }
});

export const loginChecksForgetBrowserFeature: FeatureDefinition<
    typeof loginChecksForgetBrowser.command,
    typeof loginChecksForgetBrowser.input,
    typeof loginChecksForgetBrowser.output
> = defineFeature({
    ...loginChecksForgetBrowser,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.trustedBrowsers.remove(ctx.userId, input.id);
        ctx.audit({ action: 'loginChecks.forgetBrowser', description: 'Navigateur de confiance retiré' });
        return { status: await buildStatus(ctx) };
    }
});

export const loginChecksForgetBrowsersFeature: FeatureDefinition<
    typeof loginChecksForgetBrowsers.command,
    typeof loginChecksForgetBrowsers.input,
    typeof loginChecksForgetBrowsers.output
> = defineFeature({
    ...loginChecksForgetBrowsers,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx) => {
        await ctx.db.trustedBrowsers.removeAllOf(ctx.userId);
        ctx.audit({ action: 'loginChecks.forgetBrowsers', description: 'Tous les navigateurs de confiance retirés' });
        return { status: await buildStatus(ctx) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const loginChecksFeatures: FeatureDefinition<string, any, any>[] = [
    loginChecksStatusFeature,
    loginChecksSetEmailFeature,
    loginChecksForgetBrowserFeature,
    loginChecksForgetBrowsersFeature
];
