import {
    deployAdd,
    deployCandidates,
    deployCount,
    deployGet,
    deployHistory,
    deployList,
    deployLog,
    deployRemove,
    deployReorder,
    deployTrigger,
    deployUpdate
} from 'deveye-types';
import { fetchDeploymentLog, listDeployments, listTargets, triggerDeploy } from '@/Services/integrations/dokploy';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { deployCredentialFeatures } from './credentials';
import { deployNotificationFeatures } from './notifications';
import {
    READ,
    WRITE,
    deployCipher,
    loadDokployCredential,
    loadTarget,
    reloadTarget,
    toDeployment,
    toTarget,
    type StoredDeployment,
    type StoredTarget
} from './_shared';

/**
 * Déploiement — les cibles d'un espace, et ce qu'on y a poussé.
 *
 * Feature de premier rang depuis la migration 080, et non plus un onglet des
 * Projets : une pile compose sert souvent deux projets (un client, un serveur),
 * certaines ne servent aucun projet, et un projet n'y **pointe** que par une
 * liaison (`features/project/deployLink.ts`). C'est la forme des features Git,
 * Bases de données et Audience, et pour les mêmes raisons.
 *
 * Portée volontairement **étroite** : déclencher et suivre. DevEye ne configure
 * rien — ni domaine, ni variable d'environnement, ni build. Tout cela vit chez
 * le fournisseur, dont ce n'est pas à nous de dupliquer l'interface.
 *
 * ⚠️ Préfixe unique `deploy.` avec des noms en camelCase : le contrôle de
 * démarrage de `_topics.ts` cherche un verbe **juste après le point** et n'en
 * verra donc aucun. `mutates` est à relire à la main sur chaque écriture.
 */

export const deployListFeature: FeatureDefinition<
    typeof deployList.command,
    typeof deployList.input,
    typeof deployList.output
> = defineFeature({
    ...deployList,
    access: READ,
    handler: async (ctx) => {
        const cipher = deployCipher(ctx);
        const rows = await ctx.db.deploy.listTargets(ctx.workspaceId);
        return { targets: await Promise.all(rows.map((row) => toTarget(cipher, row))) };
    }
});

export const deployCountFeature: FeatureDefinition<
    typeof deployCount.command,
    typeof deployCount.input,
    typeof deployCount.output
> = defineFeature({
    ...deployCount,
    access: READ,
    handler: async (ctx) => ({ count: await ctx.db.deploy.countTargets(ctx.workspaceId) })
});

export const deployGetFeature: FeatureDefinition<
    typeof deployGet.command,
    typeof deployGet.input,
    typeof deployGet.output
> = defineFeature({
    ...deployGet,
    access: READ,
    handler: async (ctx, input) => {
        const cipher = deployCipher(ctx);
        const [target, rows, projectIds] = await Promise.all([
            reloadTarget(ctx, input.targetId),
            ctx.db.deploy.listDeployments(input.targetId, ctx.workspaceId, input.limit ?? 20),
            ctx.db.deploy.listLinkedProjectIds(input.targetId, ctx.workspaceId)
        ]);
        return {
            target,
            deployments: await Promise.all(rows.map((row) => toDeployment(cipher, row))),
            projectIds
        };
    }
});

export const deployAddFeature: FeatureDefinition<
    typeof deployAdd.command,
    typeof deployAdd.input,
    typeof deployAdd.output
> = defineFeature({
    ...deployAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // La clé existe-t-elle, et dans **cet** espace ? Sans cette garde on
        // déclarerait une cible sur le jeton d'un autre espace, dont l'existence
        // même n'a pas à fuiter.
        await loadDokployCredential(ctx, input.credentialId);

        const cipher = deployCipher(ctx);
        const body: StoredTarget = { name: input.name };

        // Idempotente : la même application sur la même instance est la même
        // cible. On met son intitulé à jour plutôt que d'en créer une jumelle —
        // c'est ce qui permet à un projet de « déclarer » une cible sans savoir
        // si un autre l'a déjà fait.
        const existing = await ctx.db.deploy.findTargetByExternal(
            ctx.workspaceId,
            input.credentialId,
            input.externalId
        );
        if (existing) {
            await ctx.db.deploy.updateTarget(existing.id, ctx.workspaceId, {
                credentialId: input.credentialId,
                kind: input.kind,
                externalId: input.externalId,
                content: await cipher.encrypt(JSON.stringify(body))
            });
            return { target: await reloadTarget(ctx, existing.id) };
        }

        const row = await ctx.db.deploy.createTarget({
            workspaceId: ctx.workspaceId,
            credentialId: input.credentialId,
            provider: 'dokploy',
            kind: input.kind,
            externalId: input.externalId,
            content: await cipher.encrypt(JSON.stringify(body))
        });
        ctx.audit({
            action: 'deploy.add',
            description: `Cible de déploiement déclarée : ${input.name}`,
            metadata: { targetId: row.id, externalId: input.externalId }
        });
        return { target: await reloadTarget(ctx, row.id) };
    }
});

export const deployUpdateFeature: FeatureDefinition<
    typeof deployUpdate.command,
    typeof deployUpdate.input,
    typeof deployUpdate.output
> = defineFeature({
    ...deployUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadTarget(ctx, input.targetId);
        if (input.credentialId !== null) await loadDokployCredential(ctx, input.credentialId);

        const body: StoredTarget = { name: input.name };
        const row = await ctx.db.deploy.updateTarget(input.targetId, ctx.workspaceId, {
            credentialId: input.credentialId,
            kind: input.kind,
            externalId: input.externalId,
            content: await deployCipher(ctx).encrypt(JSON.stringify(body))
        });
        if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
        return { target: await reloadTarget(ctx, input.targetId) };
    }
});

export const deployRemoveFeature: FeatureDefinition<
    typeof deployRemove.command,
    typeof deployRemove.input,
    typeof deployRemove.output
> = defineFeature({
    ...deployRemove,
    // Deux sujets : les projets qui la déployaient perdent leur liaison, donc un
    // onglet ouvert ailleurs doit se rafraîchir aussi.
    mutates: ['deploy', 'projects'],
    access: WRITE,
    handler: async (ctx, input) => {
        await loadTarget(ctx, input.targetId);
        // L'historique et les liaisons partent en CASCADE. L'application chez le
        // fournisseur, elle, n'est évidemment jamais touchée : DevEye ne fait
        // que la pointer.
        const ok = await ctx.db.deploy.deleteTarget(input.targetId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
        ctx.audit({
            action: 'deploy.remove',
            description: 'Cible de déploiement supprimée',
            metadata: { targetId: input.targetId }
        });
        return { targetId: input.targetId };
    }
});

export const deployReorderFeature: FeatureDefinition<
    typeof deployReorder.command,
    typeof deployReorder.input,
    typeof deployReorder.output
> = defineFeature({
    ...deployReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await ctx.db.deploy.reorderTargets(ctx.workspaceId, input.targetIds);
        return { targetIds: input.targetIds };
    }
});

export const deployCandidatesFeature: FeatureDefinition<
    typeof deployCandidates.command,
    typeof deployCandidates.input,
    typeof deployCandidates.output
> = defineFeature({
    ...deployCandidates,
    access: WRITE,
    handler: async (ctx, input) => {
        const { baseUrl, apiKey } = await loadDokployCredential(ctx, input.credentialId);
        try {
            // Applications **et** piles compose : sur une infra Dokploy, les
            // secondes sont souvent majoritaires.
            const targets = await listTargets(baseUrl, apiKey);
            return {
                candidates: targets.map((t) => ({
                    kind: t.kind,
                    externalId: t.externalId,
                    name: t.name,
                    path: t.path
                }))
            };
        } catch (e) {
            throw new FeatureError('internal', e instanceof Error ? e.message : 'Instance Dokploy injoignable.');
        }
    }
});

export const deployTriggerFeature: FeatureDefinition<
    typeof deployTrigger.command,
    typeof deployTrigger.input,
    typeof deployTrigger.output
> = defineFeature({
    ...deployTrigger,
    // Le projet aussi : l'événement entre dans sa frise, et son onglet doit le
    // voir arriver sans recharger.
    mutates: ['deploy', 'projects'],
    access: WRITE,
    handler: async (ctx, input) => {
        const target = await loadTarget(ctx, input.targetId);
        if (target.credential_id === null) {
            throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez une clé.');
        }
        const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id);

        const cipher = deployCipher(ctx);
        const title = input.title || 'Déploiement depuis DevEye';
        const body: StoredDeployment = { title, description: input.description, url: baseUrl };

        // La ligne est écrite **avant** l'appel : si le fournisseur accepte puis
        // que la réponse se perd, il reste une trace de ce qui a été déclenché.
        // Un déploiement fantôme est moins grave qu'un déploiement invisible.
        const row = await ctx.db.deploy.createDeployment({
            targetId: target.id,
            workspaceId: ctx.workspaceId,
            externalId: null,
            triggeredByUserId: ctx.userId,
            content: await cipher.encrypt(JSON.stringify(body))
        });

        // Audité en `warn` : c'est la seule action du module qui produise un
        // effet hors de DevEye.
        ctx.audit({
            level: 'warning',
            action: 'deploy.trigger',
            description: `Déploiement déclenché : ${title}`,
            metadata: { targetId: target.id, externalId: target.external_id, projectId: input.projectId ?? null }
        });

        try {
            await triggerDeploy(
                baseUrl,
                apiKey,
                target.target_kind === 'compose' ? 'compose' : 'application',
                target.external_id,
                title,
                input.description
            );
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Déclenchement refusé.';
            await ctx.db.deploy.updateDeployment(row.id, {
                externalId: null,
                status: 'failed',
                finishedAt: Math.floor(Date.now() / 1000),
                content: await cipher.encrypt(
                    JSON.stringify({ ...body, description: `${input.description}\n${message}`.trim() })
                )
            });
            throw new FeatureError('internal', message);
        }

        // La frise du projet, quand le geste est parti de l'un d'eux. Facultatif
        // par construction : déclenché depuis la feature, ce déploiement
        // n'appartient à aucun projet en particulier, et l'inscrire dans l'un
        // d'eux au hasard serait faux.
        if (input.projectId !== undefined) await recordProjectEvent(ctx, input.projectId, title);

        // Le suivi d'état est repris par l'ordonnanceur : c'est lui qui ira
        // demander à Dokploy où en est ce déploiement. `wake()` et non
        // `requestSync()` — il n'y a aucun dépôt git à synchroniser ici, juste
        // un tour à déclencher plus tôt que la cadence.
        ctx.integrations?.wake();

        return { deployment: await toDeployment(cipher, row) };
    }
});

/**
 * L'historique complet d'une cible, tel que Dokploy le rend.
 *
 * Distincte de `deployGet` : celle-ci interroge le fournisseur en direct à
 * chaque appel plutôt que de relire le suivi local, donc coûte une requête
 * externe et peut échouer si l'instance est injoignable — raison pour laquelle
 * rien ne l'appelle en boucle ni depuis une liste de plusieurs cibles.
 */
export const deployHistoryFeature: FeatureDefinition<
    typeof deployHistory.command,
    typeof deployHistory.input,
    typeof deployHistory.output
> = defineFeature({
    ...deployHistory,
    access: READ,
    handler: async (ctx, input) => {
        const target = await loadTarget(ctx, input.targetId);
        // Le jeton a été retiré : rien à interroger, mais ce n'est pas une
        // erreur — la fiche le dit déjà par ailleurs (« accès retiré »).
        if (target.credential_id === null) return { entries: [] };

        const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id);
        try {
            const remote = await listDeployments(
                baseUrl,
                apiKey,
                target.target_kind === 'compose' ? 'compose' : 'application',
                target.external_id
            );
            return { entries: [...remote].sort((a, b) => b.startedAt - a.startedAt) };
        } catch (e) {
            throw new FeatureError('internal', e instanceof Error ? e.message : 'Instance Dokploy injoignable.');
        }
    }
});

/**
 * Le journal complet d'un déploiement, tel que Dokploy l'a produit.
 *
 * Reconstitue le chemin du journal en repassant par l'historique complet
 * plutôt que de le faire porter au client : ce chemin est un détail
 * d'implémentation du fournisseur (un emplacement sur son disque), pas
 * quelque chose que DevEye a de raison d'exposer.
 */
export const deployLogFeature: FeatureDefinition<
    typeof deployLog.command,
    typeof deployLog.input,
    typeof deployLog.output
> = defineFeature({
    ...deployLog,
    access: READ,
    handler: async (ctx, input) => {
        const target = await loadTarget(ctx, input.targetId);
        if (target.credential_id === null) {
            throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez une clé.');
        }
        const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id);

        const remote = await listDeployments(
            baseUrl,
            apiKey,
            target.target_kind === 'compose' ? 'compose' : 'application',
            target.external_id
        ).catch((e) => {
            throw new FeatureError('internal', e instanceof Error ? e.message : 'Instance Dokploy injoignable.');
        });
        const match = remote.find((d) => d.externalId === input.externalId);
        if (!match?.logPath) throw new FeatureError('not_found', 'Aucun journal pour ce déploiement.');

        try {
            return { log: await fetchDeploymentLog(baseUrl, apiKey, match.logPath) };
        } catch (e) {
            throw new FeatureError('internal', e instanceof Error ? e.message : 'Flux de journaux injoignable.');
        }
    }
});

/**
 * Inscrit le déclenchement dans la frise du projet d'où il est parti.
 *
 * Traverse la frontière des deux modules, et c'est assumé : c'est le seul point
 * où le déploiement a quelque chose à dire à un projet. Le passage par
 * `projectHistory` plutôt que par `recordEvent` évite d'importer le socle des
 * projets entier — et **ne lève jamais** : le déploiement a déjà eu lieu, perdre
 * une ligne de frise ne doit pas le transformer en échec.
 */
async function recordProjectEvent(
    ctx: Parameters<typeof loadTarget>[0],
    projectId: number,
    title: string
): Promise<void> {
    try {
        const project = await ctx.db.projects.findById(projectId, ctx.workspaceId);
        // Un projet gardé n'a pas de déploiement (sa liaison est refusée) : s'il
        // s'en présente un, c'est qu'on regarde le mauvais projet.
        if (!project || project.security_tier !== 'open') return;
        await ctx.db.projectHistory.record({
            projectId,
            workspaceId: ctx.workspaceId,
            actorUserId: ctx.userId,
            kind: 'deploy.triggered',
            refType: null,
            refId: null,
            content: await ctx.secure.open.encrypt(JSON.stringify({ label: title, from: null, to: null }))
        });
    } catch (e) {
        ctx.logger.warn({ err: e, projectId }, 'deploy: événement de frise non enregistré');
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deployFeatures: FeatureDefinition<string, any, any>[] = [
    deployListFeature,
    deployCountFeature,
    deployGetFeature,
    deployAddFeature,
    deployUpdateFeature,
    deployRemoveFeature,
    deployReorderFeature,
    deployCandidatesFeature,
    deployTriggerFeature,
    deployHistoryFeature,
    deployLogFeature,
    ...deployNotificationFeatures,
    ...deployCredentialFeatures
];
