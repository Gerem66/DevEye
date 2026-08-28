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
 * Déploiement — les cibles d'un espace, et ce qu'on y a poussé.
 *
 * Feature de premier rang depuis la migration 080, et non plus un onglet des
 * Projets : une pile compose sert souvent deux projets (un client, un serveur),
 * certaines ne servent aucun projet, et un projet n'y **pointe** que par une
 * liaison (`features/project/deployLink.ts`, dans l'app). C'est la forme des
 * features Git, Bases de données et Audience, et pour les mêmes raisons.
 *
 * Portée volontairement **étroite** : déclencher et suivre. DevEye ne configure
 * rien — ni domaine, ni variable d'environnement, ni build. Tout cela vit chez
 * le fournisseur, dont ce n'est pas à nous de dupliquer l'interface.
 *
 * ⚠️ Préfixe unique `deploy.` avec des noms en camelCase : le contrôle de
 * démarrage de `_topics.ts` cherche un verbe **juste après le point** et n'en
 * verra donc aucun. `mutates` est à relire à la main sur chaque écriture.
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
            const visible = rows.filter((r) => hidden.get(r.id) !== 'none');
            const [scope, counts] = await Promise.all([ctx.sharing.scope(), projectCountsOf(ctx)]);
            return {
                targets: await Promise.all(
                    visible.map(async (row) =>
                        toTarget(
                            await scope.cipherFor(row.id),
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
            // Les mêmes lignes que la liste — projetées comprises, restrictions
            // déduites : la carte doit compter ce que la liste montre.
            const rows = await ctx.repo.listVisibleTargets(ctx.workspaceId);
            const hidden = await ctx.items.restrictions();
            return { count: rows.filter((r) => hidden.get(r.id) !== 'none').length };
        }
    }),
    defineSdkFeature({
        ...deployGet,
        handler: async (ctx: Ctx, input) => {
            // La ligne d'abord : c'est elle qui dit où vivent l'historique et sa
            // clé — chez la cible, pas forcément ici.
            const home = await loadTarget(ctx, input.targetId);
            const cipher = await targetCipherFor(ctx, home);
            const [target, rows, projectIds] = await Promise.all([
                reloadTarget(ctx, input.targetId),
                ctx.repo.listDeployments(input.targetId, home.workspace_id, input.limit ?? 20),
                // Les liaisons de **cet** espace, par le contrat de Projets : la
                // fiche d'une cible projetée montre les projets d'ici qui la
                // déploient, pas ceux de là-bas.
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
            // La clé existe-t-elle, et dans **cet** espace ? Sans cette garde on
            // déclarerait une cible sur le jeton d'un autre espace, dont l'existence
            // même n'a pas à fuiter.
            await loadDokployCredential(ctx, input.credentialId);

            const cipher = ctx.cipher();
            const body: StoredTarget = { name: input.name };

            // Idempotente : la même application sur la même instance est la même
            // cible. On met son intitulé à jour plutôt que d'en créer une jumelle —
            // c'est ce qui permet à un projet de « déclarer » une cible sans savoir
            // si un autre l'a déjà fait.
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
            // de SON espace, que la fenêtre ne voit pas — lui en proposer d'ici
            // relierait la cible à une clé d'un autre monde.
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
        // Un seul sujet, celui du module : l'onglet d'un projet qui montre une
        // cible suit déjà `deploy.detail` / `deploy.list`. Ce que la
        // suppression ne ravive plus, ce sont les compteurs d'onglets d'un
        // projet (le sujet `projects`, qu'un module ne peut pas nommer) : ils
        // se remettent à jour à leur prochaine lecture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            await loadHomeTarget(ctx, input.targetId);
            // L'historique et les liaisons partent en CASCADE. L'application chez le
            // fournisseur, elle, n'est évidemment jamais touchée : DevEye ne fait
            // que la pointer.
            const ok = await ctx.repo.deleteTarget(input.targetId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
            // Projections, restrictions et route de notification ne tiennent à
            // aucune clé étrangère : sans ce ménage, elles s'appliqueraient à la
            // prochaine cible à hériter de l'identifiant. `ctx.items.forget` fait
            // les trois (l'ex `itemSharing.forgetItem` + `notificationChannels.clearRoute`).
            await ctx.items.forget(input.targetId);
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
    }),
    defineSdkFeature({
        ...deployTrigger,
        access: { level: 'write' },
        // Le sujet du module : l'onglet du projet suit `deploy.detail`, et voit
        // l'événement arriver sans recharger. Sa frise (le sujet `projects`,
        // qu'un module ne nomme pas) se relit à sa prochaine ouverture.
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Déclencher depuis une fenêtre est permis — c'est tout l'intérêt de
            // projeter une cible vers l'espace d'une équipe — mais tout ce qui
            // s'écrit appartient au domicile : la ligne, sa clé, son suivi.
            const target = await loadTarget(ctx, input.targetId, 'write');
            if (target.credential_id === null) {
                throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez une clé.');
            }
            const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id, target);

            const cipher = await targetCipherFor(ctx, target);
            const title = input.title || 'Déploiement depuis DevEye';
            const body: StoredDeployment = { title, description: input.description, url: baseUrl };

            // La ligne est écrite **avant** l'appel : si le fournisseur accepte puis
            // que la réponse se perd, il reste une trace de ce qui a été déclenché.
            // Un déploiement fantôme est moins grave qu'un déploiement invisible.
            const row = await ctx.repo.createDeployment({
                targetId: target.id,
                workspaceId: target.workspace_id,
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

            // La frise du projet, quand le geste est parti de l'un d'eux. Facultatif
            // par construction : déclenché depuis la feature, ce déploiement
            // n'appartient à aucun projet en particulier, et l'inscrire dans l'un
            // d'eux au hasard serait faux.
            if (input.projectId !== undefined) {
                await recordProjectEvent(ctx, input.projectId, target.workspace_id, title);
            }

            // Le suivi d'état est repris par l'ordonnanceur du module : c'est lui
            // qui ira demander à Dokploy où en est ce déploiement. `wake()` et non
            // `requestSync()` — il n'y a aucun dépôt git à synchroniser ici, juste
            // un tour à déclencher plus tôt que la cadence.
            wakeSync();

            return { deployment: await toDeployment(cipher, row) };
        }
    }),
    /**
     * L'historique complet d'une cible, tel que Dokploy le rend.
     *
     * Distincte de `deployGet` : celle-ci interroge le fournisseur en direct à
     * chaque appel plutôt que de relire le suivi local, donc coûte une requête
     * externe et peut échouer si l'instance est injoignable — raison pour laquelle
     * rien ne l'appelle en boucle ni depuis une liste de plusieurs cibles.
     */
    defineSdkFeature({
        ...deployHistory,
        handler: async (ctx: Ctx, input) => {
            const target = await loadTarget(ctx, input.targetId);
            // Le jeton a été retiré : rien à interroger, mais ce n'est pas une
            // erreur — la fiche le dit déjà par ailleurs (« accès retiré »).
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
     * Le journal complet d'un déploiement, tel que Dokploy l'a produit.
     *
     * Reconstitue le chemin du journal en repassant par l'historique complet
     * plutôt que de le faire porter au client : ce chemin est un détail
     * d'implémentation du fournisseur (un emplacement sur son disque), pas
     * quelque chose que DevEye a de raison d'exposer.
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

    // ------------------------------------------------------------ clés Dokploy
    //
    // Les clés d'API **Dokploy** de l'espace.
    //
    // Elles vivaient dans la feature Git, où elles n'avaient jamais eu de raison
    // d'être : un jeton git et une clé de mise en production ne se ressemblent
    // que par leur forme. Elles y étaient parce que le déploiement n'était alors
    // qu'un onglet de projet, sans écran à lui pour les accueillir — la feature
    // ayant désormais le sien, poser la clé qui déploie relève de `deploy`, pas
    // de `git`. Le rapatriement en module leur a donné leur table
    // (`ft_deploy_credentials`, migration 099) et leurs quatre gestes ICI, là où
    // `_credentials.ts` les partageait avec la porte de Git. L'adresse de
    // l'instance est **obligatoire** — Dokploy est auto-hébergé, sans elle rien
    // n'est adressable ; le contrat l'exige.
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
            // Neuf, donc encore utilisé par rien.
            return { credential: toCredential(row, 0) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.updateCredential(input.credentialId, ctx.workspaceId, {
                label: input.label,
                baseUrl: input.baseUrl,
                // Secret absent = inchangé. Le client ne l'a jamais reçu, il ne peut
                // donc pas le renvoyer à l'identique.
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
            // Ce qui s'en servait garde sa ligne mais perd son accès (le dépôt
            // met les cibles à NULL avant de retirer la clé) : le déploiement
            // s'arrête proprement et le dit, au lieu de disparaître avec le jeton.
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
