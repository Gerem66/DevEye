import {
    AUDIENCE_MAX_FUNNELS,
    audienceFunnelAdd,
    audienceFunnelList,
    audienceFunnelRemove,
    audienceFunnelUpdate,
    type AudienceFunnel,
    type AudienceFunnelStepDraft,
    type AudienceFunnelStepKind
} from 'deveye-types';

import type { ResolvedStep } from '@/db/repos/audienceFunnels';
import type { Cipher } from '@/Services/SecureStore';
import { labelRef, normalizePath } from '@/Services/audience/normalize';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { audienceCipher, loadSite, nameRef, rangeWindow, READ, readLabel, WRITE } from './_shared';

/**
 * Les entonnoirs d'un site : où les gens décrochent.
 *
 * ## Le découpage, et pourquoi il tient tout
 *
 * Le site suivi émet des **signaux nommés** — une page vue, un
 * `deveye.event('etape-email')`. L'entonnoir, lui, se compose **ici**, à partir
 * de ce qui a déjà été observé. Trois conséquences, et ce sont elles qui font
 * la valeur de la feature :
 *
 * - mesurer un autre parcours ne demande **aucun redéploiement** du site ;
 * - un entonnoir supprimé ne perd **aucune donnée** — le recréer à l'identique
 *   rend exactement les mêmes chiffres ;
 * - un entonnoir peut être défini **avant** que le site n'émette le signal : la
 *   marche compte alors zéro, ce qui est la vérité, pas une erreur.
 *
 * ## La règle de rétention, et il faut la connaître
 *
 * Une visite « atteint la marche i » si la **première occurrence** de chacune
 * des marches 1..i s'est produite dans l'ordre. C'est déterministe et ça tient
 * en une requête ; le prix est qu'un visiteur qui revient en arrière puis repart
 * peut ne pas être compté. Une définition floue aurait été pire qu'une
 * définition stricte qu'on énonce.
 */

/** La normalisation d'une marche, la même que celle de l'ingestion. */
function stepValue(kind: AudienceFunnelStepKind, raw: string): string {
    // Un chemin passe par `normalizePath` — sans quoi une marche écrite
    // « /tarifs/ » ne reconnaîtrait jamais la page « /tarifs » que l'ingestion a
    // rangée. Un nom d'événement est pris tel quel, comme à l'entrée.
    return kind === 'path' ? normalizePath(raw) : raw.trim();
}

/** Ce qu'on écrit pour une marche : sa valeur normalisée et son condensé. */
async function toStoredStep(
    cipher: Cipher,
    step: AudienceFunnelStepDraft
): Promise<{ kind: string; labelRef: string; content: string; value: string }> {
    const value = stepValue(step.kind, step.value);
    return { kind: step.kind, labelRef: labelRef(value), content: await cipher.encrypt(value), value };
}

/** L'entonnoir de cet espace, ou `not_found`. La jointure est la garde. */
async function loadFunnel(ctx: FeatureContext, funnelId: number) {
    const row = await ctx.db.audienceFunnels.findInWorkspace(funnelId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Entonnoir introuvable');
    return row;
}

export const audienceFunnelListFeature: FeatureDefinition<
    typeof audienceFunnelList.command,
    typeof audienceFunnelList.input,
    typeof audienceFunnelList.output
> = defineFeature({
    ...audienceFunnelList,
    access: READ,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        const cipher = audienceCipher(ctx);
        const window = rangeWindow(input.range, Math.floor(Date.now() / 1000));

        const [rows, stepRows] = await Promise.all([
            ctx.db.audienceFunnels.list(input.siteId),
            ctx.db.audienceFunnels.listSteps(input.siteId)
        ]);
        if (rows.length === 0) return { funnels: [] };

        // Les libellés de **toutes** les marches en une fois : un site a
        // quelques entonnoirs de quelques marches, une requête par marche aurait
        // été une rafale pour rien.
        const labels = await ctx.db.audienceFunnels.resolveLabels(
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
            const counts = await ctx.db.audienceFunnels.retention(input.siteId, resolved, window.from, window.to);
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

export const audienceFunnelAddFeature: FeatureDefinition<
    typeof audienceFunnelAdd.command,
    typeof audienceFunnelAdd.input,
    typeof audienceFunnelAdd.output
> = defineFeature({
    ...audienceFunnelAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        if ((await ctx.db.audienceFunnels.count(input.siteId)) >= AUDIENCE_MAX_FUNNELS) {
            throw new FeatureError(
                'validation',
                `Un site ne peut pas porter plus de ${AUDIENCE_MAX_FUNNELS} entonnoirs.`
            );
        }
        const ref = nameRef(input.name);
        if (await ctx.db.audienceFunnels.findByName(input.siteId, ref)) {
            throw new FeatureError('validation', 'Un entonnoir porte déjà ce nom sur ce site.');
        }

        const cipher = audienceCipher(ctx);
        const funnelId = await ctx.db.audienceFunnels.create({
            siteId: input.siteId,
            nameRef: ref,
            content: await cipher.encrypt(input.name.trim())
        });
        await ctx.db.audienceFunnels.replaceSteps(
            funnelId,
            input.siteId,
            await Promise.all(input.steps.map((step) => toStoredStep(cipher, step)))
        );
        ctx.audit({ action: 'audience.funnelAdd', description: `Entonnoir « ${input.name.trim()} » défini` });
        return { funnelId };
    }
});

export const audienceFunnelUpdateFeature: FeatureDefinition<
    typeof audienceFunnelUpdate.command,
    typeof audienceFunnelUpdate.input,
    typeof audienceFunnelUpdate.output
> = defineFeature({
    ...audienceFunnelUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const funnel = await loadFunnel(ctx, input.funnelId);
        const ref = nameRef(input.name);
        const clash = await ctx.db.audienceFunnels.findByName(funnel.site_id, ref);
        if (clash && clash.id !== funnel.id) {
            throw new FeatureError('validation', 'Un entonnoir porte déjà ce nom sur ce site.');
        }

        const cipher = audienceCipher(ctx);
        await ctx.db.audienceFunnels.rename(funnel.id, ref, await cipher.encrypt(input.name.trim()));
        await ctx.db.audienceFunnels.replaceSteps(
            funnel.id,
            funnel.site_id,
            await Promise.all(input.steps.map((step) => toStoredStep(cipher, step)))
        );
        return { ok: true as const };
    }
});

export const audienceFunnelRemoveFeature: FeatureDefinition<
    typeof audienceFunnelRemove.command,
    typeof audienceFunnelRemove.input,
    typeof audienceFunnelRemove.output
> = defineFeature({
    ...audienceFunnelRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const funnel = await loadFunnel(ctx, input.funnelId);
        // Pas de confirmation lourde côté serveur, et c'est justifié : aucune
        // mesure ne disparaît. Seule la lecture qu'on en faisait s'en va.
        await ctx.db.audienceFunnels.remove(funnel.id);
        return { ok: true as const };
    }
});

export const audienceFunnelFeatures = [
    audienceFunnelListFeature,
    audienceFunnelAddFeature,
    audienceFunnelUpdateFeature,
    audienceFunnelRemoveFeature
];
