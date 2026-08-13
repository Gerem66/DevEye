import {
    audienceCount,
    audienceGet,
    audienceList,
    audienceReorder,
    audienceSiteAdd,
    audienceSiteRemove,
    audienceSiteRotateKey,
    audienceSiteUpdate,
    type AudienceUsage
} from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { tryDecryptProject } from '../project/_shared';
import {
    audienceCipher,
    generatePublicKey,
    ingestOrigin,
    loadSite,
    nameRef,
    packOrigins,
    READ,
    toSite,
    WRITE,
    type StoredSite
} from './_shared';

/**
 * Les sites suivis de l'espace : inventaire, réglages, clé, ordre.
 *
 * **Rien ici ne mesure quoi que ce soit.** Ces commandes déclarent des sites et
 * lisent ce qu'ils sont ; les chiffres viennent de `stats.ts`, et les
 * événements entrent par une porte qui n'est pas une commande du tout
 * (`src/audience/routes.ts`).
 *
 * ⚠️ Toute écriture qui touche à l'identité, à l'état ou aux origines d'un site
 * doit appeler `ctx.audience?.invalidate()`. L'ingestion tient un cache
 * `clé publique → site` pour ne pas interroger la base à chaque visite : sans
 * cet appel, un site éteint continuerait d'accepter des mesures pendant toute
 * la vie du processus, et c'est le genre de panne qu'on ne voit qu'en relisant
 * des chiffres qu'on croyait arrêtés.
 */

export const audienceCountFeature: FeatureDefinition<
    typeof audienceCount.command,
    typeof audienceCount.input,
    typeof audienceCount.output
> = defineFeature({
    ...audienceCount,
    access: READ,
    handler: async (ctx) => ({ count: await ctx.db.audience.count(ctx.workspaceId) })
});

export const audienceListFeature: FeatureDefinition<
    typeof audienceList.command,
    typeof audienceList.input,
    typeof audienceList.output
> = defineFeature({
    ...audienceList,
    access: READ,
    handler: async (ctx) => {
        const cipher = audienceCipher(ctx);
        const rows = await ctx.db.audience.list(ctx.workspaceId);
        return { sites: await Promise.all(rows.map((row) => toSite(cipher, row))) };
    }
});

export const audienceGetFeature: FeatureDefinition<
    typeof audienceGet.command,
    typeof audienceGet.input,
    typeof audienceGet.output
> = defineFeature({
    ...audienceGet,
    access: READ,
    handler: async (ctx, input) => {
        const row = await ctx.db.audience.findWithStats(input.siteId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Site introuvable');
        const cipher = audienceCipher(ctx);

        // Les projets liés, avec leur titre : c'est ce qui rend l'interconnexion
        // cliquable dans les deux sens. Ils sont tous à l'étage ouvert (un
        // projet confidentiel ne peut pas lier), donc lisibles sans session.
        const usage: AudienceUsage[] = await Promise.all(
            (await ctx.db.audience.listUsage(input.siteId, ctx.workspaceId)).map(async (u) => ({
                projectId: u.project_id,
                title: (await tryDecryptProject(cipher, u.content))?.title || 'Sans titre',
                status: u.status as AudienceUsage['status']
            }))
        );

        return { site: await toSite(cipher, row), usage, ingestOrigin: ingestOrigin() };
    }
});

export const audienceSiteAddFeature: FeatureDefinition<
    typeof audienceSiteAdd.command,
    typeof audienceSiteAdd.input,
    typeof audienceSiteAdd.output
> = defineFeature({
    ...audienceSiteAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const ref = nameRef(input.name);
        if (await ctx.db.audience.findByName(ctx.workspaceId, ref)) {
            throw new FeatureError('validation', 'Un site porte déjà ce nom dans cet espace.');
        }

        const cipher = audienceCipher(ctx);
        const body: StoredSite = { name: input.name.trim(), description: input.description.trim() };
        const created = await ctx.db.audience.create({
            workspaceId: ctx.workspaceId,
            publicKey: generatePublicKey(),
            nameRef: ref,
            platform: input.platform,
            visitorMode: input.visitorMode,
            origins: packOrigins(input.origins),
            active: input.active,
            retentionDays: input.retentionDays,
            content: await cipher.encrypt(JSON.stringify(body))
        });
        ctx.audience?.invalidate();
        ctx.audit({ action: 'audience.siteAdd', description: `Site de suivi « ${body.name} » déclaré` });

        const row = await ctx.db.audience.findWithStats(created.id, ctx.workspaceId);
        if (!row) throw new FeatureError('internal', 'Site introuvable après création');
        return { site: await toSite(cipher, row) };
    }
});

export const audienceSiteUpdateFeature: FeatureDefinition<
    typeof audienceSiteUpdate.command,
    typeof audienceSiteUpdate.input,
    typeof audienceSiteUpdate.output
> = defineFeature({
    ...audienceSiteUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        const ref = nameRef(input.name);
        const clash = await ctx.db.audience.findByName(ctx.workspaceId, ref);
        if (clash && clash.id !== input.siteId) {
            throw new FeatureError('validation', 'Un site porte déjà ce nom dans cet espace.');
        }

        const cipher = audienceCipher(ctx);
        const body: StoredSite = { name: input.name.trim(), description: input.description.trim() };
        const updated = await ctx.db.audience.update(input.siteId, ctx.workspaceId, {
            nameRef: ref,
            platform: input.platform,
            visitorMode: input.visitorMode,
            origins: packOrigins(input.origins),
            active: input.active,
            retentionDays: input.retentionDays,
            content: await cipher.encrypt(JSON.stringify(body))
        });
        if (!updated) throw new FeatureError('not_found', 'Site introuvable');
        ctx.audience?.invalidate();

        const row = await ctx.db.audience.findWithStats(input.siteId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Site introuvable');
        return { site: await toSite(cipher, row) };
    }
});

export const audienceSiteRotateKeyFeature: FeatureDefinition<
    typeof audienceSiteRotateKey.command,
    typeof audienceSiteRotateKey.input,
    typeof audienceSiteRotateKey.output
> = defineFeature({
    ...audienceSiteRotateKey,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        await ctx.db.audience.setPublicKey(input.siteId, ctx.workspaceId, generatePublicKey());
        // Sans cette invalidation, l'ancienne clé resterait acceptée jusqu'au
        // prochain redémarrage — c'est-à-dire que la rotation ne servirait à
        // rien, précisément dans le cas où on la demande.
        ctx.audience?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.siteRotateKey',
            description: 'Clé publique d’un site de suivi renouvelée',
            metadata: { siteId: input.siteId }
        });

        const cipher = audienceCipher(ctx);
        const row = await ctx.db.audience.findWithStats(input.siteId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Site introuvable');
        return { site: await toSite(cipher, row) };
    }
});

export const audienceSiteRemoveFeature: FeatureDefinition<
    typeof audienceSiteRemove.command,
    typeof audienceSiteRemove.input,
    typeof audienceSiteRemove.output
> = defineFeature({
    ...audienceSiteRemove,
    mutates: ['audience', 'projects'],
    access: WRITE,
    handler: async (ctx, input) => {
        await loadSite(ctx, input.siteId);
        // Libellés, sessions, événements, agrégat et liaisons partent en
        // CASCADE. Les projets qui suivaient ce site ne perdent qu'un pointeur,
        // d'où le second sujet diffusé : leur onglet doit se relire.
        const removed = await ctx.db.audience.remove(input.siteId, ctx.workspaceId);
        if (!removed) throw new FeatureError('not_found', 'Site introuvable');
        ctx.audience?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.siteRemove',
            description: 'Site de suivi supprimé, historique compris',
            metadata: { siteId: input.siteId }
        });
        return { ok: true as const };
    }
});

export const audienceReorderFeature: FeatureDefinition<
    typeof audienceReorder.command,
    typeof audienceReorder.input,
    typeof audienceReorder.output
> = defineFeature({
    ...audienceReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Aucune invalidation ici : l'ordre d'affichage n'entre dans aucune
        // décision de l'ingestion, et vider son cache pour un glisser-déposer
        // lui ferait relire la base sans raison.
        await ctx.db.audience.reorder(ctx.workspaceId, input.siteIds);
        return { ok: true as const };
    }
});
