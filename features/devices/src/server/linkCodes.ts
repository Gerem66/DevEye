import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { devicesLinkCodeCreate, devicesLinkCodeList, devicesLinkCodeRevoke } from '../contracts/commands';
import { env } from './env';
import type { DevicesRepo } from './repo';
import { WRITE } from './_shared';

/**
 * Les codes de liaison : ce qu'on émet pour enrôler une machine dans cet
 * espace. L'agent présente le code à `POST /api/agent/enroll`, route publique
 * de l'app qui le consomme ; ici, l'émission, la relecture et la révocation,
 * par l'espace actif. Sous `devices: write` : appairer, c'est poser un
 * appareil dans l'espace.
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
        const ttlSeconds = input.ttlSeconds ?? env.LINK_CODE_TTL_SECONDS;
        // La machine se range là où on l'appaire : le code ne vise que
        // l'espace actif, celui dont l'appelant tient le droit d'écriture.
        const workspaceId = ctx.workspaceId;
        const created = await ctx.repo.linkCodes.create({ userId: ctx.userId, workspaceId, ttlSeconds });
        // Un code est un secret : le journal dit qu'il a été émis, pour où et
        // pour combien de temps, jamais sa valeur.
        ctx.audit({
            action: 'devices.linkCodeCreate',
            description: 'Code de liaison émis',
            metadata: { workspaceId, ttlSeconds }
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
    handler: async (ctx) => ({ codes: await ctx.repo.linkCodes.listActive(ctx.workspaceId) })
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
        const removed = await ctx.repo.linkCodes.revoke(ctx.workspaceId, code);
        if (!removed) throw new FeatureError('not_found', 'Code not found');
        return { code };
    }
});
