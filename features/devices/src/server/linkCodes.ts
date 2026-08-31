import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    devicesLinkCodeCreate,
    devicesLinkCodeList,
    devicesLinkCodeRevoke,
    devicesLinkCodeSetAutoApprove
} from '../contracts/commands';
import { env } from './env';
import type { DevicesRepo } from './repo';
import { WRITE } from './_shared';

/**
 * Les codes de liaison : ce qu'on émet pour enrôler une machine dans cet
 * espace. L'agent présente le code à `POST /api/agent/enroll`, route publique
 * de l'app qui le consomme ; ici, l'émission, la relecture, l'auto-approbation
 * et la révocation, par leur émetteur. Sous `devices: write` : appairer, c'est
 * poser un appareil dans l'espace.
 */

/** Un code se saisit à la main : il se compare sans ses espaces ni sa casse. */
function normalize(code: string): string {
    return code.trim().toUpperCase();
}

export const devicesLinkCodeCreateFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesLinkCodeCreate.command,
    typeof devicesLinkCodeCreate.input,
    typeof devicesLinkCodeCreate.output
>({
    ...devicesLinkCodeCreate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // undefined → server default; null → never expires; number → custom.
        const ttlSeconds = input.ttlSeconds === undefined ? env.LINK_CODE_TTL_SECONDS : input.ttlSeconds;
        // La machine se range là où on l'appaire : le code ne vise que
        // l'espace actif, celui dont l'appelant tient le droit d'écriture.
        const workspaceId = ctx.workspaceId;
        const created = await ctx.repo.linkCodes.create({
            userId: ctx.userId,
            workspaceId,
            ttlSeconds,
            autoApprove: input.autoApprove
        });
        // Un code est un secret : le journal dit qu'il a été émis, pour où et
        // sous quelles conditions, jamais sa valeur.
        ctx.audit({
            action: 'devices.linkCodeCreate',
            description: `Code de liaison émis${input.autoApprove ? ' (approbation automatique)' : ''}`,
            metadata: { workspaceId, ttlSeconds, autoApprove: input.autoApprove }
        });
        return created;
    }
});

export const devicesLinkCodeListFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesLinkCodeList.command,
    typeof devicesLinkCodeList.input,
    typeof devicesLinkCodeList.output
>({
    ...devicesLinkCodeList,
    access: WRITE,
    // Active (unconsumed, unexpired) link codes.
    handler: async (ctx) => ({ codes: await ctx.repo.linkCodes.listActive(ctx.userId) })
});

export const devicesLinkCodeSetAutoApproveFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesLinkCodeSetAutoApprove.command,
    typeof devicesLinkCodeSetAutoApprove.input,
    typeof devicesLinkCodeSetAutoApprove.output
>({
    ...devicesLinkCodeSetAutoApprove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const updated = await ctx.repo.linkCodes.setAutoApprove(ctx.userId, normalize(input.code), input.autoApprove);
        if (!updated) throw new FeatureError('not_found', 'Code not found');
        return updated;
    }
});

export const devicesLinkCodeRevokeFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesLinkCodeRevoke.command,
    typeof devicesLinkCodeRevoke.input,
    typeof devicesLinkCodeRevoke.output
>({
    ...devicesLinkCodeRevoke,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const code = normalize(input.code);
        const removed = await ctx.repo.linkCodes.revoke(ctx.userId, code);
        if (!removed) throw new FeatureError('not_found', 'Code not found');
        return { code };
    }
});
