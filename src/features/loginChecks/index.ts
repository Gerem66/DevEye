import {
    loginChecksForgetBrowser,
    loginChecksForgetBrowsers,
    loginChecksPhoneConfirm,
    loginChecksPhoneRemove,
    loginChecksPhoneStart,
    loginChecksSetEmail,
    loginChecksSetSms,
    loginChecksStatus,
    type LoginChecksStatus
} from '@deveye/types';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

import { timingSafeEqual } from 'node:crypto';

import { LOGIN_CODE_TTL_MS, hashCode, randomCode } from '@/auth/loginChallenge';
import { maskEmail, maskPhone } from '@/auth/mask';
import { phoneContext } from '@/Services/sealContexts';
import { serverMail } from '@/Services/serverMail';
import { sms, SmsQuotaError, SmsReceiverRefusedError } from '@/Services/sms';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertAccountPassword } from '../_password';

/** Codes faux tolérés sur un numéro en cours de vérification avant de l'oublier. */
const PHONE_MAX_FAILURES = 5;

/** Les numéros en cours de vérification, par compte : le numéro et le condensé de son code. */
const pendingPhones = new Map<number, { e164: string; hash: string; expiresAt: number; failures: number }>();

/** Le numéro vérifié du compte, en clair pour le serveur seul ; `null` sans numéro ou illisible. */
export async function phoneOf(ctx: Pick<FeatureContext, 'db' | 'crypt'>, userId: number): Promise<string | null> {
    const row = await ctx.db.userPhones.get(userId);
    return row ? ctx.crypt.openTextFor('phone', row.phone_sealed, phoneContext(userId)) : null;
}

async function buildStatus(ctx: FeatureContext): Promise<LoginChecksStatus> {
    const user = await ctx.db.users.findById(ctx.userId);
    if (!user) throw new FeatureError('not_found', 'Compte introuvable');
    const browsers = await ctx.db.trustedBrowsers.listByUser(ctx.userId, Math.floor(Date.now() / 1000));
    const phoneRow = await ctx.db.userPhones.get(ctx.userId);
    const phone = phoneRow ? await phoneOf(ctx, ctx.userId) : null;
    return {
        email: {
            available: serverMail.configured,
            enabled: user.login_email_check === 1,
            to: maskEmail(user.email)
        },
        sms: {
            available: sms.available,
            enabled: phoneRow?.sms_check === 1,
            phone: phone ? maskPhone(phone) : null
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

export const loginChecksSetSmsFeature: FeatureDefinition<
    typeof loginChecksSetSms.command,
    typeof loginChecksSetSms.input,
    typeof loginChecksSetSms.output
> = defineFeature({
    ...loginChecksSetSms,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        if (!(await ctx.db.userPhones.get(ctx.userId))) {
            throw new FeatureError('conflict', 'Ajoutez d’abord un numéro de téléphone');
        }
        if (!input.enabled) {
            if (!input.password) throw new FeatureError('validation', 'Mot de passe requis');
            await assertAccountPassword(ctx, input.password, 'loginChecks.setSms_failed');
        }
        await ctx.db.userPhones.setSmsCheck(ctx.userId, input.enabled);
        ctx.audit({
            action: 'loginChecks.setSms',
            level: input.enabled ? 'info' : 'warning',
            description: input.enabled
                ? 'Code par SMS aux connexions depuis un nouveau navigateur : activé'
                : 'Code par SMS aux connexions depuis un nouveau navigateur : désactivé'
        });
        return { status: await buildStatus(ctx) };
    }
});

export const loginChecksPhoneStartFeature: FeatureDefinition<
    typeof loginChecksPhoneStart.command,
    typeof loginChecksPhoneStart.input,
    typeof loginChecksPhoneStart.output
> = defineFeature({
    ...loginChecksPhoneStart,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        if (!sms.available) throw new FeatureError('conflict', 'Ce serveur n’envoie pas de SMS');
        // Déplacer le code par SMS vers un autre téléphone : une session volée ne le fait pas seule.
        await assertAccountPassword(ctx, input.password, 'loginChecks.phoneStart_failed');
        const raw = input.phone.trim();
        // Sans indicatif, un numéro se lit comme français, le pays du service.
        const parsed = raw.startsWith('+') ? parsePhoneNumberFromString(raw) : parsePhoneNumberFromString(raw, 'FR');
        if (!parsed?.isValid()) throw new FeatureError('validation', 'Ce numéro de téléphone n’est pas valide');
        const type = parsed.getType();
        if (type && type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') {
            throw new FeatureError('validation', 'Ce numéro ne reçoit pas de SMS : donnez un numéro de mobile');
        }
        const e164 = parsed.number;
        const code = randomCode();
        try {
            await sms.send(e164, `DevEye : votre code de vérification est ${code}. Il expire dans 10 minutes.`, {
                userId: ctx.userId,
                ip: ctx.ip
            });
        } catch (e) {
            if (e instanceof SmsQuotaError) throw new FeatureError('rate_limited', e.message);
            if (e instanceof SmsReceiverRefusedError) {
                throw new FeatureError('validation', 'Ce numéro ne reçoit pas de SMS : donnez un numéro de mobile');
            }
            ctx.logger.error({ err: (e as Error).message }, 'SMS de vérification non envoyé');
            throw new FeatureError('internal', 'Le SMS n’a pas pu partir. Réessayez plus tard.');
        }
        pendingPhones.set(ctx.userId, {
            e164,
            hash: hashCode(ctx.crypt, code),
            expiresAt: Date.now() + LOGIN_CODE_TTL_MS,
            failures: 0
        });
        ctx.audit({
            action: 'loginChecks.phoneStart',
            description: `Code de vérification envoyé au ${maskPhone(e164)}`
        });
        return { to: maskPhone(e164) };
    }
});

export const loginChecksPhoneConfirmFeature: FeatureDefinition<
    typeof loginChecksPhoneConfirm.command,
    typeof loginChecksPhoneConfirm.input,
    typeof loginChecksPhoneConfirm.output
> = defineFeature({
    ...loginChecksPhoneConfirm,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        const pending = pendingPhones.get(ctx.userId);
        if (!pending || Date.now() >= pending.expiresAt) {
            pendingPhones.delete(ctx.userId);
            throw new FeatureError('auth_expired', 'Code expiré : demandez-en un nouveau');
        }
        const expected = Buffer.from(pending.hash, 'hex');
        const given = Buffer.from(hashCode(ctx.crypt, input.code), 'hex');
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
            pending.failures += 1;
            if (pending.failures >= PHONE_MAX_FAILURES) pendingPhones.delete(ctx.userId);
            ctx.audit({
                action: 'loginChecks.phoneConfirm_failed',
                level: 'warning',
                description: 'Code de vérification du numéro incorrect'
            });
            throw new FeatureError('auth_invalid', 'Code incorrect');
        }
        pendingPhones.delete(ctx.userId);
        await ctx.db.userPhones.save(
            ctx.userId,
            ctx.crypt.sealFor('phone', pending.e164, phoneContext(ctx.userId)),
            Math.floor(Date.now() / 1000)
        );
        ctx.audit({
            action: 'loginChecks.phoneConfirm',
            level: 'warning',
            description: `Numéro de téléphone vérifié (${maskPhone(pending.e164)}), code par SMS activé`
        });
        return { status: await buildStatus(ctx) };
    }
});

export const loginChecksPhoneRemoveFeature: FeatureDefinition<
    typeof loginChecksPhoneRemove.command,
    typeof loginChecksPhoneRemove.input,
    typeof loginChecksPhoneRemove.output
> = defineFeature({
    ...loginChecksPhoneRemove,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        await assertAccountPassword(ctx, input.password, 'loginChecks.phoneRemove_failed');
        await ctx.db.userPhones.remove(ctx.userId);
        pendingPhones.delete(ctx.userId);
        ctx.audit({ action: 'loginChecks.phoneRemove', level: 'warning', description: 'Numéro de téléphone retiré' });
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
    loginChecksSetSmsFeature,
    loginChecksPhoneStartFeature,
    loginChecksPhoneConfirmFeature,
    loginChecksPhoneRemoveFeature,
    loginChecksForgetBrowserFeature,
    loginChecksForgetBrowsersFeature
];
