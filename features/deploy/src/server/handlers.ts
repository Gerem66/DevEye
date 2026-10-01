import {
    deployAdd,
    deployCandidates,
    deployCount,
    deployCredentialAdd,
    deployCredentialDevices,
    deployCredentialList,
    deployCredentialRemove,
    deployCredentialUpdate,
    deployGet,
    deployHistory,
    deployList,
    deployLog,
    deployMachines,
    deployRemove,
    deployReorder,
    deployTrigger,
    deployUpdate
} from '../contracts/commands';
import { randomUUID } from 'node:crypto';

import type { Deployment, DeployTarget, DeployTargetRow } from '../contracts/domain';
import { authorizeRelayDevice, defineSdkFeature, FeatureError, relayDeviceOptions } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : l'adresse refusée l'est
// à l'écriture, là où le membre voit pourquoi.
import { isAllowedOutboundUrl, OUTBOUND_REFUSED_MESSAGE } from '@/Services/netFetch';

import { candidatesOf, machineOf, parseServiceId } from './agent';
import { recallHistoryEntry, rememberHistory } from './historyCache';
import { DOKPLOY_INSTANCE } from './providers/dokploy';
import type { DeployProviderAdapter } from './providers/types';
import {
    deviceNamesOf,
    liveAgentLog,
    loadAccess,
    loadHomeTarget,
    loadTarget,
    projectCountsOf,
    projectIdsOf,
    providerTargetOf,
    readJson,
    recordProjectEvent,
    reloadTarget,
    startAgentDeploy,
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

/** Le refus d'un fournisseur, dans ses mots : c'est lui qui sait pourquoi. */
function refusal(e: unknown, fallback: string): FeatureError {
    return new FeatureError('internal', e instanceof Error ? e.message : fallback);
}

/** Un type de cible que ce fournisseur ne sait pas déployer n'entre pas. */
function assertKind(provider: DeployProviderAdapter, kind: string): void {
    if (!(provider.kinds as readonly string[]).includes(kind)) {
        throw new FeatureError('validation', 'Ce type de cible ne se déploie pas par cet accès.');
    }
}

/**
 * Par où joindre une instance Dokploy : sans objet pour GitHub. Jointe par le
 * serveur, l'adresse doit être publique ; jointe par un appareil, c'est son
 * agent qui borne ce qu'il atteint, et l'appelant devient l'auteur du choix,
 * dont le droit sur l'appareil sera revérifié à chaque usage.
 */
async function routeFor(
    ctx: Ctx,
    provider: string,
    input: { baseUrl: string | null; deviceId: string | null }
): Promise<{ baseUrl: string | null; deviceId: string | null; authorUserId: number | null }> {
    if (provider !== 'dokploy') return { baseUrl: null, deviceId: null, authorUserId: null };
    if (!input.baseUrl) throw new FeatureError('validation', 'Une instance Dokploy demande son adresse.');
    if (input.deviceId) {
        const device = await authorizeRelayDevice(ctx, input.deviceId, DOKPLOY_INSTANCE);
        return { baseUrl: input.baseUrl, deviceId: device.id, authorUserId: ctx.userId };
    }
    if (!isAllowedOutboundUrl(input.baseUrl)) throw new FeatureError('validation', OUTBOUND_REFUSED_MESSAGE);
    return { baseUrl: input.baseUrl, deviceId: null, authorUserId: null };
}

const PROVIDER_LABELS: Record<string, string> = { dokploy: 'Dokploy', github: 'GitHub' };

interface TargetInput {
    kind: DeployTarget['kind'];
    externalId: string;
    name: string;
    ref?: string | null;
}

/** Une cible par un accès (Dokploy, GitHub) : sondée, donc comptée dans l'offre. */
async function addAccessTarget(ctx: Ctx, credentialId: number, input: TargetInput): Promise<DeployTarget> {
    // La clé existe-t-elle, et dans CET espace ? Sans cette garde on
    // déclarerait une cible sur le jeton d'un autre espace.
    const { provider } = await loadAccess(ctx, credentialId);
    assertKind(provider, input.kind);

    const cipher = ctx.cipher();
    const body: StoredTarget = input.ref ? { name: input.name, ref: input.ref } : { name: input.name };

    // Idempotente : la même application sur la même instance est la même
    // cible, dont l'intitulé se met à jour. Un projet peut ainsi déclarer
    // une cible sans savoir si un autre l'a déjà fait.
    const existing = await ctx.repo.findTargetByExternal(ctx.workspaceId, credentialId, input.externalId);
    if (existing) {
        await ctx.repo.updateTarget(existing.id, ctx.workspaceId, {
            credentialId,
            kind: input.kind,
            externalId: input.externalId,
            content: await cipher.encrypt(JSON.stringify(body))
        });
        return reloadTarget(ctx, existing.id);
    }

    // Après l'idempotence : redéclarer une cible existante n'en ajoute
    // aucune, et ne doit donc jamais buter sur la limite.
    await ctx.quota.assert('targets', async (owned) => (await ctx.repo.countTargetsInWorkspaces(owned)) + 1);

    const row = await ctx.repo.createTarget({
        workspaceId: ctx.workspaceId,
        credentialId,
        deviceId: null,
        provider: provider.id,
        kind: input.kind,
        externalId: input.externalId,
        content: await cipher.encrypt(JSON.stringify(body))
    });
    ctx.audit({
        action: 'deploy.add',
        description: `Cible de déploiement déclarée : ${input.name}`,
        metadata: { targetId: row.id, externalId: input.externalId }
    });
    return reloadTarget(ctx, row.id);
}

/**
 * Une cible portée par une machine de l'espace. La déclarer revient à confier
 * à `deploy: write` le droit de relancer ce service : il faut donc soi-même
 * pouvoir en piloter les conteneurs (la permission Docker d'Appareils).
 */
async function addMachineTarget(ctx: Ctx, deviceId: string, input: TargetInput): Promise<DeployTarget> {
    if (input.kind !== 'service') throw new FeatureError('validation', 'Une machine déploie un service compose.');
    parseServiceId(input.externalId);
    await ctx.deveye.devices.authorize(deviceId, { extras: ['docker'] });

    const content = await ctx.cipher().encrypt(JSON.stringify({ name: input.name } satisfies StoredTarget));
    const existing = await ctx.repo.findTargetByDevice(ctx.workspaceId, deviceId, input.externalId);
    if (existing) {
        await ctx.repo.updateTarget(existing.id, ctx.workspaceId, {
            credentialId: null,
            kind: 'service',
            externalId: input.externalId,
            content
        });
        return reloadTarget(ctx, existing.id);
    }
    const row = await ctx.repo.createTarget({
        workspaceId: ctx.workspaceId,
        credentialId: null,
        deviceId,
        provider: 'agent',
        kind: 'service',
        externalId: input.externalId,
        content
    });
    ctx.audit({
        action: 'deploy.add',
        description: `Cible de déploiement déclarée sur une machine : ${input.name}`,
        metadata: { targetId: row.id, deviceId, externalId: input.externalId }
    });
    return reloadTarget(ctx, row.id);
}

/**
 * Un déploiement par une machine : la ligne est écrite, puis confiée au suivi
 * de fond qui attend l'agent. La commande rend la main sans attendre la fin.
 */
async function triggerOnMachine(
    ctx: Ctx,
    target: DeployTargetRow,
    input: { title: string; description: string; projectId?: number }
): Promise<Deployment> {
    if (!target.device_id) throw new FeatureError('validation', 'Cette cible ne désigne plus de machine.');
    const service = parseServiceId(target.external_id);
    if (!ctx.deveye.devices.isOnline(target.device_id)) {
        throw new FeatureError('conflict', 'La machine est hors ligne : rien ne peut s’y déployer pour l’instant.');
    }

    const cipher = await targetCipherFor(ctx, target);
    const title = input.title || 'Déploiement depuis DevEye';
    const body: StoredDeployment = { title, description: input.description, url: null };
    const row = await ctx.repo.createDeployment({
        targetId: target.id,
        workspaceId: target.workspace_id,
        // L'identifiant par lequel la fiche retrouve son journal.
        externalId: randomUUID(),
        triggeredByUserId: ctx.userId,
        content: await cipher.encrypt(JSON.stringify(body))
    });
    ctx.audit({
        level: 'warning',
        action: 'deploy.trigger',
        description: `Déploiement déclenché sur une machine : ${title}`,
        metadata: { targetId: target.id, deviceId: target.device_id, service: target.external_id }
    });

    if (!startAgentDeploy({ target, deploymentId: row.id, service })) {
        const reason = 'Le suivi des déploiements n’est pas démarré sur ce serveur.';
        await ctx.repo.updateDeployment(row.id, {
            externalId: row.external_id,
            status: 'failed',
            finishedAt: Math.floor(Date.now() / 1000),
            content: await cipher.encrypt(JSON.stringify({ ...body, description: reason }))
        });
        throw new FeatureError('internal', reason);
    }
    if (input.projectId !== undefined) await recordProjectEvent(ctx, input.projectId, target.workspace_id, title);
    return toDeployment(cipher, row);
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
            const [scope, counts, names] = await Promise.all([
                ctx.sharing.scope(),
                projectCountsOf(ctx),
                deviceNamesOf(ctx, visible)
            ]);
            return {
                targets: await Promise.all(
                    visible.map(async (row) =>
                        toTarget(
                            await scope.cipherFor(String(row.id)),
                            row,
                            row.workspace_id !== ctx.workspaceId,
                            counts.get(row.id) ?? 0,
                            ctx.quota.isPaused('targets', String(row.id)),
                            names
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
            if (input.deviceId) {
                if (input.credentialId !== null) {
                    throw new FeatureError('validation', 'Une cible vise un accès ou une machine, pas les deux.');
                }
                return { target: await addMachineTarget(ctx, input.deviceId, input) };
            }
            if (input.credentialId === null) {
                throw new FeatureError('validation', 'Choisissez un accès ou une machine.');
            }
            return { target: await addAccessTarget(ctx, input.credentialId, input) };
        }
    }),
    defineSdkFeature({
        ...deployUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : le jeton d'une cible se choisit parmi les clés
            // de SON espace, que la fenêtre ne voit pas.
            const target = await loadHomeTarget(ctx, input.targetId);
            if (target.provider === 'agent') {
                // Portée par une machine, elle le reste : on change d'intitulé ou
                // de service, pas de fournisseur.
                if (input.credentialId !== null || input.kind !== 'service') {
                    throw new FeatureError(
                        'validation',
                        'Une cible portée par une machine reste un service de cette machine.'
                    );
                }
                parseServiceId(input.externalId);
                if (target.device_id) await ctx.deveye.devices.authorize(target.device_id, { extras: ['docker'] });
            } else if (input.credentialId !== null) {
                const { provider } = await loadAccess(ctx, input.credentialId);
                if (provider.id !== target.provider) {
                    throw new FeatureError('validation', 'Cet accès sert un autre fournisseur que cette cible.');
                }
                assertKind(provider, input.kind);
            }

            const body: StoredTarget = input.ref ? { name: input.name, ref: input.ref } : { name: input.name };
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
            if (input.deviceId !== undefined) {
                await ctx.deveye.devices.authorize(input.deviceId, { extras: ['docker'] });
                const inventory = await ctx.deveye.agents.dockerInventory(input.deviceId);
                if (!inventory) throw new FeatureError('conflict', 'La machine ne répond pas : est-elle en ligne ?');
                return { candidates: candidatesOf(inventory) };
            }
            if (input.credentialId === undefined) {
                throw new FeatureError('validation', 'Choisissez un accès ou une machine.');
            }
            const { provider, access } = await loadAccess(ctx, input.credentialId);
            try {
                return { candidates: await provider.candidates(access) };
            } catch (e) {
                throw refusal(e, 'Fournisseur injoignable.');
            }
        }
    }),
    defineSdkFeature({
        ...deployMachines,
        access: { level: 'write' },
        handler: async (ctx: Ctx) => ({ machines: (await ctx.deveye.devices.list()).map(machineOf) })
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
            await ctx.quota.assertActive('targets', String(target.id));
            if (target.provider === 'agent') {
                const deployment = await triggerOnMachine(ctx, target, input);
                return { deployment };
            }
            if (target.credential_id === null) {
                throw new FeatureError('validation', 'L’accès de cette cible a été retiré : reliez-en un.');
            }
            const { provider, access } = await loadAccess(ctx, target.credential_id, target);

            const cipher = await targetCipherFor(ctx, target);
            const spec = providerTargetOf(target, await readJson<Partial<StoredTarget>>(cipher, target.content));
            const title = input.title || 'Déploiement depuis DevEye';
            const body: StoredDeployment = { title, description: input.description, url: access.baseUrl };

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
                await provider.trigger(access, spec, { title, description: input.description });
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
            // Une machine ne garde pas d'historique : c'est le nôtre. Une cible en
            // pause d'offre ne sonde pas son fournisseur : le relevé local se lit.
            if (target.provider === 'agent' || ctx.quota.isPaused('targets', String(target.id))) {
                const cipher = await targetCipherFor(ctx, target);
                const rows = await ctx.repo.listDeployments(target.id, target.workspace_id, 50);
                const deployments = await Promise.all(rows.map((row) => toDeployment(cipher, row)));
                return {
                    entries: deployments.map(({ externalId, status, title, description, startedAt, finishedAt }) => ({
                        externalId,
                        status,
                        title,
                        description,
                        startedAt,
                        finishedAt
                    }))
                };
            }
            // Le jeton a été retiré : rien à interroger, mais ce n'est pas une
            // erreur, la fiche le dit déjà (« accès retiré »).
            if (target.credential_id === null) return { entries: [] };

            const { provider, access } = await loadAccess(ctx, target.credential_id, target);
            const cipher = await targetCipherFor(ctx, target);
            const spec = providerTargetOf(target, await readJson<Partial<StoredTarget>>(cipher, target.content));
            try {
                const remote = await provider.history(access, spec);
                rememberHistory(target.id, remote);
                return {
                    entries: [...remote]
                        .sort((a, b) => b.startedAt - a.startedAt)
                        .map(({ externalId, status, title, description, startedAt, finishedAt }) => ({
                            externalId,
                            status,
                            title,
                            description,
                            startedAt,
                            finishedAt
                        }))
                };
            } catch (e) {
                throw refusal(e, 'Fournisseur injoignable.');
            }
        }
    }),
    /**
     * Le journal complet d'un déploiement. Sa référence est retrouvée dans
     * l'historique plutôt que portée par le client : chez Dokploy, c'est un
     * emplacement sur le disque du fournisseur, rien à exposer. L'historique
     * que le client vient de lister suffit le plus souvent ; le fournisseur
     * n'est réinterrogé qu'au raté.
     */
    defineSdkFeature({
        ...deployLog,
        handler: async (ctx: Ctx, input) => {
            const target = await loadTarget(ctx, input.targetId);
            const cipher = await targetCipherFor(ctx, target);
            // Le journal d'une machine est chez nous : en mémoire tant que
            // l'agent parle, puis dans la ligne du déploiement.
            if (target.provider === 'agent') {
                const rows = await ctx.repo.listDeployments(target.id, target.workspace_id, 50);
                const row = rows.find((r) => r.external_id === input.externalId);
                if (!row) throw new FeatureError('not_found', 'Aucun journal pour ce déploiement.');
                const live = liveAgentLog(row.id);
                if (live !== null) return { log: live };
                return { log: (await readJson<Partial<StoredDeployment>>(cipher, row.content))?.log ?? '' };
            }
            if (target.credential_id === null) {
                throw new FeatureError('validation', 'L’accès de cette cible a été retiré : reliez-en un.');
            }
            await ctx.quota.assertActive('targets', String(target.id));
            const { provider, access } = await loadAccess(ctx, target.credential_id, target);
            const spec = providerTargetOf(target, await readJson<Partial<StoredTarget>>(cipher, target.content));

            const match =
                recallHistoryEntry(target.id, input.externalId) ??
                (await provider.history(access, spec).then(
                    (remote) => {
                        rememberHistory(target.id, remote);
                        return remote.find((d) => d.externalId === input.externalId) ?? null;
                    },
                    (e: unknown) => {
                        throw refusal(e, 'Fournisseur injoignable.');
                    }
                ));
            if (!match) throw new FeatureError('not_found', 'Aucun journal pour ce déploiement.');

            try {
                return { log: await provider.fullLog(access, spec, match) };
            } catch (e) {
                throw refusal(e, 'Journal injoignable.');
            }
        }
    }),

    // Les accès de l'espace. L'adresse d'une instance Dokploy est obligatoire :
    // Dokploy est auto-hébergé, sans elle rien n'est adressable.
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
                provider: input.provider,
                label: input.label,
                ...(await routeFor(ctx, input.provider, input)),
                secretEnc: await ctx.cipher().encrypt(input.secret)
            });
            ctx.audit({
                action: 'deploy.credentialAdd',
                description: `Accès ${PROVIDER_LABELS[input.provider]} ajouté`,
                metadata: { credentialId: row.id, provider: input.provider }
            });
            return { credential: toCredential(row, 0) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const existing = await ctx.repo.findCredential(input.credentialId, ctx.workspaceId);
            if (!existing) throw new FeatureError('not_found', 'Accès de déploiement introuvable');
            const row = await ctx.repo.updateCredential(input.credentialId, ctx.workspaceId, {
                label: input.label,
                ...(await routeFor(ctx, existing.provider, input)),
                // Secret absent = inchangé : le client ne l'a jamais reçu.
                secretEnc: input.secret ? await ctx.cipher().encrypt(input.secret) : undefined
            });
            if (!row) throw new FeatureError('not_found', 'Accès de déploiement introuvable');
            const uses = await ctx.repo.countCredentialUses(ctx.workspaceId);
            return { credential: toCredential(row, uses.get(row.id) ?? 0) };
        }
    }),
    defineSdkFeature({
        ...deployCredentialDevices,
        access: { level: 'write' },
        handler: async (ctx: Ctx) => ({ devices: await relayDeviceOptions(ctx, DOKPLOY_INSTANCE) })
    }),
    defineSdkFeature({
        ...deployCredentialRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Les cibles de la clé gardent leur ligne mais perdent leur accès (le
            // dépôt les met à NULL avant de retirer la clé).
            const ok = await ctx.repo.removeCredential(input.credentialId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Accès de déploiement introuvable');
            ctx.audit({
                action: 'deploy.credentialRemove',
                description: 'Accès de déploiement retiré',
                metadata: { credentialId: input.credentialId }
            });
            return { credentialId: input.credentialId };
        }
    })
];
