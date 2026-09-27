import {
    audienceCount,
    audienceGet,
    audienceList,
    audienceReorder,
    audienceSiteAdd,
    audienceSiteRemove,
    audienceSiteRotateKey,
    audienceSiteUpdate
} from '../contracts/commands';
import type { AudienceSite } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { eventsUsage } from './planUsage';
import { createSiteRecord } from './sites';

import {
    generatePublicKey,
    ingestOf,
    loadHomeSite,
    loadSite,
    nameRef,
    packOrigins,
    packTransitPaths,
    projectCountsOf,
    projectUsageOf,
    siteCipher,
    toSite,
    type Ctx,
    type StoredSite
} from './_shared';

/**
 * Les sites suivis de l'espace : inventaire, réglages, clé, ordre. Rien ici ne
 * mesure quoi que ce soit ; les chiffres viennent de `stats.ts` et les
 * événements entrent par les routes publiques du module.
 *
 * Toute écriture qui touche à l'identité, à l'état ou aux origines d'un site
 * doit appeler `ingestOf()?.invalidate()` : l'ingestion tient un cache
 * `clé publique → site`, et sans cet appel un site éteint continuerait
 * d'accepter des mesures pendant toute la vie du processus.
 */

/**
 * Recharge un site du domicile avec ses chiffres. Une requête de plus après
 * chaque écriture, assumée : sans elle, `projectCount` et les compteurs du jour
 * seraient devinés, et la liste afficherait « 0 projet » sur un site qui en
 * sert trois.
 */
async function reloadHomeSite(ctx: Ctx, siteId: number): Promise<AudienceSite> {
    const row = await ctx.repo.findWithStats(siteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Site introuvable');
    const counts = await projectCountsOf(ctx);
    return toSite(ctx.cipher(), row, false, counts.get(siteId) ?? 0, ctx.quota.isPaused('sites', String(siteId)));
}

export const audienceCountFeature = defineSdkFeature({
    ...audienceCount,
    handler: async (ctx: Ctx) => {
        // Les mêmes lignes que la liste, projetées comprises et restrictions déduites :
        // la carte doit compter ce que la liste montre.
        const rows = await ctx.repo.listVisible(ctx.workspaceId);
        const hidden = await ctx.items.restrictions();
        return { count: rows.filter((r) => hidden.get(String(r.id)) !== 'none').length };
    }
});

export const audienceListFeature = defineSdkFeature({
    ...audienceList,
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.listVisible(ctx.workspaceId);
        // Les sites qu'une restriction masque pour ce rôle disparaissent de la
        // liste plutôt que d'y figurer grisés.
        const hidden = await ctx.items.restrictions();
        const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none');
        const [shares, counts, eventsQuota] = await Promise.all([
            ctx.sharing.scope(),
            projectCountsOf(ctx),
            // Une offre illisible ne doit pas priver l'espace de sa liste.
            eventsUsage(ctx.quota, ctx.repo, Math.floor(Date.now() / 1000)).catch(() => null)
        ]);
        return {
            eventsQuota,
            sites: await Promise.all(
                visible.map(async (row) =>
                    toSite(
                        await shares.cipherFor(String(row.id)),
                        row,
                        row.workspace_id !== ctx.workspaceId,
                        counts.get(row.id) ?? 0,
                        ctx.quota.isPaused('sites', String(row.id))
                    )
                )
            )
        };
    }
});

export const audienceGetFeature = defineSdkFeature({
    ...audienceGet,
    handler: async (ctx: Ctx, input) => {
        const home = await loadSite(ctx, input.siteId);
        const row = await ctx.repo.findWithStats(input.siteId, home.workspace_id);
        if (!row) throw new FeatureError('not_found', 'Site introuvable');

        // Le site est chiffré chez lui, mais les projets liés listés ici sont ceux de
        // l'espace appelant, avec leur titre, pour rendre l'interconnexion cliquable
        // dans les deux sens.
        const [usage, counts] = await Promise.all([projectUsageOf(ctx, input.siteId), projectCountsOf(ctx)]);

        return {
            site: await toSite(
                await siteCipher(ctx, row.id),
                row,
                row.workspace_id !== ctx.workspaceId,
                counts.get(row.id) ?? 0,
                ctx.quota.isPaused('sites', String(row.id))
            ),
            usage: [...usage],
            // L'adresse par laquelle un site suivi atteint l'ingestion, sans barre
            // finale (la balise la recolle). Le serveur est le seul à la connaître :
            // l'ingestion peut avoir son propre domaine, et la déduire de l'origine du
            // navigateur donnerait alors une balise fausse.
            ingestOrigin: ctx.origins.public
        };
    }
});

export const audienceSiteAddFeature = defineSdkFeature({
    ...audienceSiteAdd,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        const created = await createSiteRecord(
            { repo: ctx.repo, cipher: ctx.cipher(), quota: ctx.quota },
            ctx.workspaceId,
            input
        );
        ctx.audit({ action: 'audience.siteAdd', description: `Site de suivi « ${input.name.trim()} » déclaré` });
        return { site: await reloadHomeSite(ctx, created.id) };
    }
});

export const audienceSiteUpdateFeature = defineSdkFeature({
    ...audienceSiteUpdate,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        // Domicile seulement : les réglages d'un site (origines, rétention, mode
        // visiteur) appartiennent à son espace.
        await loadHomeSite(ctx, input.siteId);
        const ref = nameRef(input.name);
        const clash = await ctx.repo.findByName(ctx.workspaceId, ref);
        if (clash && clash.id !== input.siteId) {
            throw new FeatureError('validation', 'Un site porte déjà ce nom dans cet espace.');
        }

        const cipher = ctx.cipher();
        const body: StoredSite = {
            name: input.name.trim(),
            description: input.description.trim(),
            transitPaths: packTransitPaths(input.transitPaths)
        };
        const updated = await ctx.repo.update(input.siteId, ctx.workspaceId, {
            nameRef: ref,
            platform: input.platform,
            visitorMode: input.visitorMode,
            origins: packOrigins(input.origins),
            active: input.active,
            retentionDays: input.retentionDays,
            formsAuto: input.formsAuto,
            submissionIpQuota: input.submissionIpQuota,
            submissionBanQuota: input.submissionBanQuota,
            formHourlyQuota: input.formHourlyQuota,
            eventIpQuota: input.eventIpQuota,
            content: await cipher.encrypt(JSON.stringify(body))
        });
        if (!updated) throw new FeatureError('not_found', 'Site introuvable');
        ingestOf()?.invalidate();

        return { site: await reloadHomeSite(ctx, input.siteId) };
    }
});

export const audienceSiteRotateKeyFeature = defineSdkFeature({
    ...audienceSiteRotateKey,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        await loadHomeSite(ctx, input.siteId);
        await ctx.repo.setPublicKey(input.siteId, ctx.workspaceId, generatePublicKey());
        // Sans cette invalidation, l'ancienne clé resterait acceptée jusqu'au prochain
        // redémarrage : la rotation ne servirait à rien là où on la demande.
        ingestOf()?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.siteRotateKey',
            description: 'Clé publique d’un site de suivi renouvelée',
            metadata: { siteId: input.siteId }
        });

        return { site: await reloadHomeSite(ctx, input.siteId) };
    }
});

export const audienceSiteRemoveFeature = defineSdkFeature({
    ...audienceSiteRemove,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        await loadHomeSite(ctx, input.siteId);
        // Libellés, sessions, événements, agrégat et liaisons partent en CASCADE ; les
        // projets qui suivaient ce site ne perdent qu'un pointeur.
        const removed = await ctx.repo.remove(input.siteId, ctx.workspaceId);
        if (!removed) throw new FeatureError('not_found', 'Site introuvable');
        // Projections, restrictions et route de notification ne tiennent à aucune clé
        // étrangère : sans ce ménage, elles s'appliqueraient au prochain site à hériter
        // de l'identifiant.
        await ctx.items.forget(String(input.siteId));
        ingestOf()?.invalidate();
        ctx.audit({
            level: 'warning',
            action: 'audience.siteRemove',
            description: 'Site de suivi supprimé, historique compris',
            metadata: { siteId: input.siteId }
        });
        return { ok: true as const };
    }
});

export const audienceReorderFeature = defineSdkFeature({
    ...audienceReorder,
    mutates: true,
    access: { level: 'write' },
    handler: async (ctx: Ctx, input) => {
        // Les sites qu'une restriction masque sortent de la liste avant l'écriture :
        // les ranger depuis un identifiant énuméré dirait lesquels existent.
        const hidden = await ctx.items.restrictions();
        const siteIds = input.siteIds.filter((id) => hidden.get(String(id)) !== 'none');
        // Aucune invalidation ici : l'ordre d'affichage n'entre dans aucune décision de
        // l'ingestion, et vider son cache lui ferait relire la base sans raison.
        if (siteIds.length > 0) await ctx.repo.reorder(ctx.workspaceId, siteIds);
        return { ok: true as const };
    }
});
