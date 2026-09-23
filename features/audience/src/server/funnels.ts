import {
    audienceFunnelAdd,
    audienceFunnelList,
    audienceFunnelRemove,
    audienceFunnelUpdate
} from '../contracts/commands';
import {
    AUDIENCE_MAX_FUNNELS,
    type AudienceFunnel,
    type AudienceFunnelStepDraft,
    type AudienceFunnelStepKind
} from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import { labelRef, normalizePath } from './normalize';
import type { ResolvedStep } from './repo';
import { loadHomeSite, loadSite, nameRef, rangeWindow, readLabel, siteCipher, type Ctx } from './_shared';

/**
 * Les entonnoirs d'un site : où les gens décrochent.
 *
 * Le site suivi émet des signaux nommés ; l'entonnoir se compose ici, à partir
 * de ce qui a déjà été observé. Mesurer un autre parcours ne demande donc aucun
 * redéploiement du site, un entonnoir supprimé ne perd aucune donnée, et un
 * entonnoir défini avant que le signal n'existe compte zéro sans se tromper.
 *
 * Une visite atteint la marche i si la première occurrence de chacune des
 * marches 1..i s'est produite dans l'ordre : déterministe et tenant en une
 * requête, au prix d'un visiteur qui revient en arrière et n'est pas compté.
 */

/** La normalisation d'une marche, la même que celle de l'ingestion. */
function stepValue(kind: AudienceFunnelStepKind, raw: string): string {
    // Un chemin passe par `normalizePath`, sans quoi une marche écrite « /tarifs/ »
    // ne reconnaîtrait jamais la page « /tarifs » rangée par l'ingestion. Un nom
    // d'événement est pris tel quel, comme à l'entrée.
    return kind === 'path' ? normalizePath(raw) : raw.trim();
}

async function toStoredStep(
    cipher: SdkCipher,
    step: AudienceFunnelStepDraft
): Promise<{ kind: string; labelRef: string; content: string; value: string }> {
    const value = stepValue(step.kind, step.value);
    return { kind: step.kind, labelRef: labelRef(value), content: await cipher.encrypt(value), value };
}

/**
 * L'entonnoir de cet espace, ou `not_found`. La jointure tient la frontière
 * d'espace ; la restriction par élément, elle, se demande sur le site, sans quoi
 * un identifiant énuméré atteindrait les entonnoirs d'un site qu'un rôle masque.
 * Ses deux appelants écrivent, d'où le niveau.
 */
async function loadFunnel(ctx: Ctx, funnelId: number) {
    const row = await ctx.repo.findFunnelInWorkspace(funnelId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Entonnoir introuvable');
    await ctx.items.assert(String(row.site_id), 'write');
    return row;
}

export const audienceFunnelListFeature = defineSdkFeature({
    ...audienceFunnelList,
    handler: async (ctx: Ctx, input) => {
        await loadSite(ctx, input.siteId);
        // Le codec du domicile du site : ses entonnoirs sont chiffrés chez lui.
        const cipher = await siteCipher(ctx, input.siteId);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));

        const [rows, stepRows] = await Promise.all([
            ctx.repo.listFunnels(input.siteId),
            ctx.repo.listFunnelSteps(input.siteId)
        ]);
        if (rows.length === 0) return { funnels: [] };

        // Les libellés de toutes les marches en une fois : une requête par marche
        // aurait été une rafale pour rien.
        const labels = await ctx.repo.resolveLabels(
            input.siteId,
            stepRows.map((step) => ({ kind: step.match_kind, labelRef: step.label_ref }))
        );

        const funnels: AudienceFunnel[] = [];
        for (const row of rows) {
            const steps = stepRows.filter((step) => step.funnel_id === row.id);
            const resolved: ResolvedStep[] = steps.map((step) => ({
                kind: step.match_kind === 'path' ? 'path' : 'event',
                labelId: labels.get(`${step.match_kind}:${step.label_ref}`) ?? null
            }));
            const counts = await ctx.repo.retention(input.siteId, resolved, window.from, window.to);
            funnels.push({
                id: row.id,
                name: (await readLabel(cipher, row.content)) || 'Sans nom',
                steps: await Promise.all(
                    steps.map(async (step, i) => ({
                        kind: step.match_kind === 'path' ? ('path' as const) : ('event' as const),
                        value: await readLabel(cipher, step.content),
                        sessions: counts[i] ?? 0
                    }))
                )
            });
        }
        return { funnels };
    }
});

export const audienceFunnelAddFeature = defineSdkFeature({
    ...audienceFunnelAdd,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        // Domicile seulement : un entonnoir appartient au site, donc à son espace.
        await loadHomeSite(ctx, input.siteId);
        if ((await ctx.repo.countFunnels(input.siteId)) >= AUDIENCE_MAX_FUNNELS) {
            throw new FeatureError(
                'validation',
                `Un site ne peut pas porter plus de ${AUDIENCE_MAX_FUNNELS} entonnoirs.`
            );
        }
        const ref = nameRef(input.name);
        if (await ctx.repo.findFunnelByName(input.siteId, ref)) {
            throw new FeatureError('validation', 'Un entonnoir porte déjà ce nom sur ce site.');
        }

        const cipher = ctx.cipher();
        const funnelId = await ctx.repo.createFunnel({
            siteId: input.siteId,
            nameRef: ref,
            content: await cipher.encrypt(input.name.trim())
        });
        await ctx.repo.replaceFunnelSteps(
            funnelId,
            input.siteId,
            await Promise.all(input.steps.map((step) => toStoredStep(cipher, step)))
        );
        ctx.audit({ action: 'audience.funnelAdd', description: `Entonnoir « ${input.name.trim()} » défini` });
        return { funnelId };
    }
});

export const audienceFunnelUpdateFeature = defineSdkFeature({
    ...audienceFunnelUpdate,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const funnel = await loadFunnel(ctx, input.funnelId);
        const ref = nameRef(input.name);
        const clash = await ctx.repo.findFunnelByName(funnel.site_id, ref);
        if (clash && clash.id !== funnel.id) {
            throw new FeatureError('validation', 'Un entonnoir porte déjà ce nom sur ce site.');
        }

        const cipher = ctx.cipher();
        await ctx.repo.renameFunnel(funnel.id, ref, await cipher.encrypt(input.name.trim()));
        await ctx.repo.replaceFunnelSteps(
            funnel.id,
            funnel.site_id,
            await Promise.all(input.steps.map((step) => toStoredStep(cipher, step)))
        );
        return { ok: true as const };
    }
});

export const audienceFunnelRemoveFeature = defineSdkFeature({
    ...audienceFunnelRemove,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const funnel = await loadFunnel(ctx, input.funnelId);
        // Pas de confirmation lourde : aucune mesure ne disparaît, seule la lecture
        // qu'on en faisait s'en va.
        await ctx.repo.removeFunnel(funnel.id);
        return { ok: true as const };
    }
});
