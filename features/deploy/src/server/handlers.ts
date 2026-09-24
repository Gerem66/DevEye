import {
    deployAdd,
    deployCandidates,
    deployCount,
    deployCredentialAdd,
    deployCredentialList,
    deployCredentialRemove,
    deployCredentialUpdate,
    deployGet,
    deployHistory,
    deployList,
    deployLog,
    deployRemove,
    deployReorder,
    deployTrigger,
    deployUpdate
} from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : l'adresse refusée l'est
// à l'écriture, là où le membre voit pourquoi.
import { isAllowedOutboundUrl, OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';

import { fetchDeploymentLog, listDeployments, listTargets, triggerDeploy } from './dokploy';
import {
    loadDokployCredential,
    loadHomeTarget,
    loadTarget,
    projectCountsOf,
    projectIdsOf,
    recordProjectEvent,
    reloadTarget,
    targetCipherFor,
    toCredential,
    toDeployment,
    toTarget,
    wakeSync,
    type Ctx,
    type StoredDeployment,
    type StoredTarget
} from './_shared';

/**
 * Déploiement : les cibles d'un espace, et ce qu'on y a poussé. Une cible
 * appartient à l'espace, un projet n'y pointe que par une liaison. Portée
 * étroite : déclencher et suivre, rien n'est configuré ici.
 *
 * Préfixe unique `deploy.` avec des noms en camelCase : le contrôle de
 * démarrage de `_topics.ts` cherche un verbe juste après le point et n'en verra
 * aucun. `mutates` est à relire à la main sur chaque écriture.
 */

/** Le type d'une cible, tel que l'adaptateur Dokploy le prend. */
function kindOf(target: { target_kind: string }): 'application' | 'compose' {
    return target.target_kind === 'compose' ? 'compose' : 'application';
}

export const deployHandlers = [
    defineSdkFeature({
        ...deployList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listVisibleTargets(ctx.workspaceId);
            // Les cibles qu'une restriction masque pour ce rôle disparaissent de la
            // liste plutôt que d'y figurer grisées.
            const hidden = await ctx.items.restrictions();
            const visible = rows.filter((r) => hidden.get(String(r.id)) !== 'none');
            const [scope, counts] = await Promise.all([ctx.sharing.scope(), projectCountsOf(ctx)]);
            return {
                targets: await Promise.all(
                    visible.map(async (row) =>
                        toTarget(
                            await scope.cipherFor(String(row.id)),
                            row,
                            row.workspace_id !== ctx.workspaceId,
                            counts.get(row.id) ?? 0
                        )
                    )
                )
            };
        }
    }),
    defineSdkFeature({
        ...deployCount,
        handler: async (ctx: Ctx) => {
            // Les mêmes lignes que la liste, projetées comprises, restrictions
            // déduites : la carte doit compter ce que la liste montre.
            const rows = await ctx.repo.listVisibleTargets(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            return { count: rows.filter((r) => hidden.get(String(r.id)) !== 'none').length };
        }
    }),
    defineSdkFeature({
        ...deployGet,
        handler: async (ctx: Ctx, input) => {
            // La ligne d'abord : c'est elle qui dit où vivent l'historique et sa
            // clé, chez la cible, pas forcément ici.
            const home = await loadTarget(ctx, input.targetId);
            const cipher = await targetCipherFor(ctx, home);
            const [target, rows, projectIds] = await Promise.all([
                reloadTarget(ctx, input.targetId),
                ctx.repo.listDeployments(input.targetId, home.workspace_id, input.limit ?? 20),
                // Les liaisons de CET espace : une cible projetée montre les
                // projets d'ici qui la déploient, pas ceux de là-bas.
                projectIdsOf(ctx, input.targetId)
            ]);
            return {
                target,
                deployments: await Promise.all(rows.map((row) => toDeployment(cipher, row))),
                projectIds
            };
        }
    }),
    defineSdkFeature({
        ...deployAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // La clé existe-t-elle, et dans CET espace ? Sans cette garde on
            // déclarerait une cible sur le jeton d'un autre espace.
            await loadDokployCredential(ctx, input.credentialId);

            const cipher = ctx.cipher();
            const body: StoredTarget = { name: input.name };

            // Idempotente : la même application sur la même instance est la même
            // cible, dont l'intitulé se met à jour. Un projet peut ainsi déclarer
            // une cible sans savoir si un autre l'a déjà fait.
            const existing = await ctx.repo.findTargetByExternal(ctx.workspaceId, input.credentialId, input.externalId);
            if (existing) {
                await ctx.repo.updateTarget(existing.id, ctx.workspaceId, {
                    credentialId: input.credentialId,
                    kind: input.kind,
                    externalId: input.externalId,
                    content: await cipher.encrypt(JSON.stringify(body))
                });
                return { target: await reloadTarget(ctx, existing.id) };
            }

            // Après l'idempotence : redéclarer une cible existante n'en ajoute
            // aucune, et ne doit donc jamais buter sur la limite.
            await ctx.quota.assert('targets', async (owned) => (await ctx.repo.countTargetsInWorkspaces(owned)) + 1);

            const row = await ctx.repo.createTarget({
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
    }),
    defineSdkFeature({
        ...deployUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : le jeton d'une cible se choisit parmi les clés
            // de SON espace, que la fenêtre ne voit pas.
            await loadHomeTarget(ctx, input.targetId);
            if (input.credentialId !== null) await loadDokployCredential(ctx, input.credentialId);

            const body: StoredTarget = { name: input.name };
            const row = await ctx.repo.updateTarget(input.targetId, ctx.workspaceId, {
                credentialId: input.credentialId,
                kind: input.kind,
                externalId: input.externalId,
                content: await ctx.cipher().encrypt(JSON.stringify(body))
            });
            if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
            return { target: await reloadTarget(ctx, input.targetId) };
        }
    }),
    defineSdkFeature({
        ...deployRemove,
        access: { level: 'write' },
        // Le sujet du module seulement : les compteurs d'onglets d'un projet
        // (sujet `projects`, qu'un module ne nomme pas) se relisent à leur
        // prochaine ouverture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await loadHomeTarget(ctx, input.targetId);
            // L'historique et les liaisons partent en CASCADE ; l'application chez
            // le fournisseur n'est jamais touchée.
            const ok = await ctx.repo.deleteTarget(input.targetId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
            // Projections, restrictions et route de notification ne tiennent à
            // aucune clé étrangère : sans ce ménage, elles s'appliqueraient à la
            // prochaine cible à hériter de l'identifiant.
            await ctx.items.forget(String(input.targetId));
            ctx.audit({
                action: 'deploy.remove',
                description: 'Cible de déploiement supprimée',
                metadata: { targetId: input.targetId }
            });
            return { targetId: input.targetId };
        }
    }),
    defineSdkFeature({
        ...deployReorder,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await ctx.repo.reorderTargets(ctx.workspaceId, input.targetIds);
            return { targetIds: input.targetIds };
        }
    }),
    defineSdkFeature({
        ...deployCandidates,
        access: { level: 'write' },
        handler: async (ctx: Ctx, input) => {
            const { baseUrl, apiKey } = await loadDokployCredential(ctx, input.credentialId);
            try {
                // Applications et piles compose.
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
    }),
    defineSdkFeature({
        ...deployTrigger,
        access: { level: 'write' },
        // L'onglet du projet suit `deploy.detail` ; sa frise (sujet `projects`,
        // qu'un module ne nomme pas) se relit à sa prochaine ouverture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Déclencher depuis une fenêtre est permis, mais tout ce qui s'écrit
            // appartient au domicile : la ligne, sa clé, son suivi.
            const target = await loadTarget(ctx, input.targetId, 'write');
            if (target.credential_id === null) {
                throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez une clé.');
            }
            const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id, target);

            const cipher = await targetCipherFor(ctx, target);
            const title = input.title || 'Déploiement depuis DevEye';
            const body: StoredDeployment = { title, description: input.description, url: baseUrl };

            // La ligne est écrite AVANT l'appel : si le fournisseur accepte puis que
            // la réponse se perd, il reste une trace de ce qui a été déclenché.
            const row = await ctx.repo.createDeployment({
                targetId: target.id,
                workspaceId: target.workspace_id,
                externalId: null,
                triggeredByUserId: ctx.userId,
                content: await cipher.encrypt(JSON.stringify(body))
            });

            // Audité en `warn` : la seule action du module à effet hors de DevEye.
            ctx.audit({
                level: 'warning',
                action: 'deploy.trigger',
                description: `Déploiement déclenché : ${title}`,
                metadata: { targetId: target.id, externalId: target.external_id, projectId: input.projectId ?? null }
            });

            try {
                await triggerDeploy(baseUrl, apiKey, kindOf(target), target.external_id, title, input.description);
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Déclenchement refusé.';
                await ctx.repo.updateDeployment(row.id, {
                    externalId: null,
                    status: 'failed',
                    finishedAt: Math.floor(Date.now() / 1000),
                    content: await cipher.encrypt(
                        JSON.stringify({ ...body, description: `${input.description}\n${message}`.trim() })
                    )
                });
                throw new FeatureError('internal', message);
            }

            // La frise du projet, quand le geste est parti de l'un d'eux ; depuis
            // la feature, ce déploiement n'appartient à aucun projet.
            if (input.projectId !== undefined) {
                await recordProjectEvent(ctx, input.projectId, target.workspace_id, title);
            }

            // Le suivi d'état est repris par le rapprochement de fond, réveillé
            // plutôt qu'attendu à sa cadence.
            wakeSync();

            return { deployment: await toDeployment(cipher, row) };
        }
    }),
    /**
     * L'historique complet, interrogé chez le fournisseur à chaque appel :
     * rien ne l'appelle en boucle ni depuis une liste.
     */
    defineSdkFeature({
        ...deployHistory,
        handler: async (ctx: Ctx, input) => {
            const target = await loadTarget(ctx, input.targetId);
            // Le jeton a été retiré : rien à interroger, mais ce n'est pas une
            // erreur, la fiche le dit déjà (« accès retiré »).
            if (target.credential_id === null) return { entries: [] };

            const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id, target);
            try {
                const remote = await listDeployments(baseUrl, apiKey, kindOf(target), target.external_id);
                return { entries: [...remote].sort((a, b) => b.startedAt - a.startedAt) };
            } catch (e) {
                throw new FeatureError('internal', e instanceof Error ? e.message : 'Instance Dokploy injoignable.');
            }
        }
    }),
    /**
     * Le journal complet d'un déploiement. Le chemin du journal est retrouvé en
     * repassant par l'historique plutôt que porté par le client : c'est un
     * emplacement sur le disque du fournisseur, rien à exposer.
     */
    defineSdkFeature({
        ...deployLog,
        handler: async (ctx: Ctx, input) => {
            const target = await loadTarget(ctx, input.targetId);
            if (target.credential_id === null) {
                throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez une clé.');
            }
            const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id, target);

            const remote = await listDeployments(baseUrl, apiKey, kindOf(target), target.external_id).catch((e) => {
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
    }),

    // Les clés d'API Dokploy de l'espace. L'adresse de l'instance est
    // obligatoire : Dokploy est auto-hébergé, sans elle rien n'est adressable.
    defineSdkFeature({
        ...deployCredentialList,
        handler: async (ctx: Ctx) => {
            const [rows, uses] = await Promise.all([
                ctx.repo.listCredentials(ctx.workspaceId),
                ctx.repo.countCredentialUses(ctx.workspaceId)
            ]);
            return { credentials: rows.map((row) => toCredential(row, uses.get(row.id) ?? 0)) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            if (!isAllowedOutboundUrl(input.baseUrl)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
            const row = await ctx.repo.createCredential({
                workspaceId: ctx.workspaceId,
                label: input.label,
                baseUrl: input.baseUrl,
                secretEnc: await ctx.cipher().encrypt(input.secret)
            });
            ctx.audit({
                action: 'deploy.credentialAdd',
                description: 'Accès Dokploy ajouté',
                metadata: { credentialId: row.id }
            });
            return { credential: toCredential(row, 0) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            if (!isAllowedOutboundUrl(input.baseUrl)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
            const row = await ctx.repo.updateCredential(input.credentialId, ctx.workspaceId, {
                label: input.label,
                baseUrl: input.baseUrl,
                // Secret absent = inchangé : le client ne l'a jamais reçu.
                secretEnc: input.secret ? await ctx.cipher().encrypt(input.secret) : undefined
            });
            if (!row) throw new FeatureError('not_found', 'Accès Dokploy introuvable');
            const uses = await ctx.repo.countCredentialUses(ctx.workspaceId);
            return { credential: toCredential(row, uses.get(row.id) ?? 0) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Les cibles de la clé gardent leur ligne mais perdent leur accès (le
            // dépôt les met à NULL avant de retirer la clé).
            const ok = await ctx.repo.removeCredential(input.credentialId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Accès Dokploy introuvable');
            ctx.audit({
                action: 'deploy.credentialRemove',
                description: 'Accès Dokploy retiré',
                metadata: { credentialId: input.credentialId }
            });
            return { credentialId: input.credentialId };
        }
    })
];
