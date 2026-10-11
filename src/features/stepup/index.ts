import {
    STEP_UP_MINUTES_DEFAULT,
    stepUpConfirm,
    stepUpSetInterval,
    stepUpStatus,
    type StepUpStatus
} from '@deveye/types';

import type { Database } from '@/db';
import { rememberStepUp, stepUpUntil, touchStepUp } from '@/Services/stepUp';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertValidCode } from '../twofa';

/** La fenêtre du compte, en secondes. */
async function windowSeconds(db: Database, userId: number): Promise<number> {
    const user = await db.users.findById(userId);
    return user?.step_up_interval ?? STEP_UP_MINUTES_DEFAULT * 60;
}

async function buildStatus(ctx: FeatureContext): Promise<StepUpStatus> {
    const twoFa = await ctx.db.twoFactor.get(ctx.userId);
    const seconds = await windowSeconds(ctx.db, ctx.userId);
    return {
        twoFactor: Boolean(twoFa?.enabled),
        minutes: Math.round(seconds / 60),
        confirmedUntil: twoFa?.enabled ? stepUpUntil(ctx.sessionId, ctx.userId, seconds * 1000) : null
    };
}

/** Ce qu'il faut pour éprouver la confirmation : une commande la porte, la façade du SDK aussi. */
export type StepUpScope = Pick<FeatureContext, 'db' | 'userId' | 'sessionId'>;

/**
 * Lève `stepup_required` sauf si l'appelant a l'application d'authentification
 * et y a pris un code dans cette session depuis moins que sa fenêtre ; sinon,
 * la fenêtre repart. À poser là où une machine va agir, jamais sur ce qui ne
 * fait que la regarder : un mot de passe ou un cookie volés regardent, ils ne
 * pilotent pas.
 */
export async function assertStepUp(scope: StepUpScope): Promise<void> {
    const twoFa = await scope.db.twoFactor.get(scope.userId);
    if (!twoFa?.enabled) {
        throw new FeatureError('stepup_required', 'Activez la double authentification pour piloter vos machines.', {
            twoFactor: false
        });
    }
    const windowMs = (await windowSeconds(scope.db, scope.userId)) * 1000;
    if (stepUpUntil(scope.sessionId, scope.userId, windowMs) === null) {
        throw new FeatureError(
            'stepup_required',
            'Confirmez avec le code de votre application pour piloter cette machine.',
            { twoFactor: true }
        );
    }
    touchStepUp(scope.sessionId);
}

export const stepUpStatusFeature: FeatureDefinition<
    typeof stepUpStatus.command,
    typeof stepUpStatus.input,
    typeof stepUpStatus.output
> = defineFeature({
    ...stepUpStatus,
    access: { scope: 'account' },
    handler: async (ctx) => ({ status: await buildStatus(ctx) })
});

export const stepUpConfirmFeature: FeatureDefinition<
    typeof stepUpConfirm.command,
    typeof stepUpConfirm.input,
    typeof stepUpConfirm.output
> = defineFeature({
    ...stepUpConfirm,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        await assertValidCode(ctx, input.code, 'stepup.failed');
        rememberStepUp(ctx.sessionId, ctx.userId);
        ctx.audit({ action: 'stepup.confirmed', description: 'Pilotage des machines confirmé pour la session' });
        return { status: await buildStatus(ctx) };
    }
});

export const stepUpSetIntervalFeature: FeatureDefinition<
    typeof stepUpSetInterval.command,
    typeof stepUpSetInterval.input,
    typeof stepUpSetInterval.output
> = defineFeature({
    ...stepUpSetInterval,
    access: { scope: 'account' },
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.users.setStepUpInterval(ctx.userId, input.minutes * 60);
        ctx.audit({
            action: 'stepup.setInterval',
            description: `Code redemandé après ${input.minutes} min sans piloter de machine`
        });
        return { status: await buildStatus(ctx) };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stepUpFeatures: FeatureDefinition<string, any, any>[] = [
    stepUpStatusFeature,
    stepUpConfirmFeature,
    stepUpSetIntervalFeature
];
