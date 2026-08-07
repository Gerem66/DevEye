import {
    projectDeployCandidates,
    projectDeployGet,
    projectDeployLink,
    projectDeployList,
    projectDeployTrigger,
    projectDeployUnlink
} from 'deveye-types';
import type { DeployStatus, ProjectDeployment, ProjectDeploymentRow, ProjectDeployTargetRow } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import { listApplications, triggerDeploy } from '@/Services/projectProviders/dokploy';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertProjectUnlocked, cipherFor, loadProject, recordEvent } from './_shared';

/**
 * Déploiement : lier une application, la déclencher, suivre l'état.
 *
 * DevEye ne configure rien — ni domaine, ni variable d'environnement, ni
 * build. Il déclenche et il observe. Tout le reste vit chez le fournisseur,
 * qui le fait mieux et dont ce n'est pas à nous de dupliquer l'interface.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

function toStatus(raw: string): DeployStatus {
    return raw === 'success' || raw === 'failed' || raw === 'running' ? raw : 'queued';
}

async function toDeployment(cipher: Cipher, row: ProjectDeploymentRow): Promise<ProjectDeployment> {
    const body = await readJson<{ title?: string; description?: string; url?: string }>(cipher, row.content);
    return {
        id: row.id,
        provider: row.provider === 'github' ? 'github' : 'dokploy',
        externalId: row.external_id,
        status: toStatus(row.status),
        triggeredByUserId: row.triggered_by_user_id,
        title: body?.title ?? '',
        description: body?.description ?? '',
        url: body?.url || null,
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at)
    };
}

async function toTarget(cipher: Cipher, row: ProjectDeployTargetRow) {
    const body = await readJson<{ name?: string }>(cipher, row.content);
    return {
        projectId: row.project_id,
        provider: (row.provider === 'github' ? 'github' : 'dokploy') as 'github' | 'dokploy',
        externalId: row.external_id,
        name: body?.name ?? row.external_id,
        credentialId: row.credential_id
    };
}

/** Charge un identifiant Dokploy utilisable, ou explique ce qui manque. */
async function loadDokployCredential(
    ctx: FeatureContext,
    credentialId: number
): Promise<{ baseUrl: string; apiKey: string }> {
    const credential = await ctx.db.projectGit.findCredential(credentialId, ctx.workspaceId);
    if (!credential) throw new FeatureError('not_found', 'Identifiant introuvable');
    if (credential.provider !== 'dokploy') {
        throw new FeatureError('validation', 'Cet identifiant n’est pas un accès Dokploy.');
    }
    if (!credential.base_url) {
        throw new FeatureError('validation', 'Cet accès Dokploy n’a pas d’adresse d’instance.');
    }
    // Étage ouvert, toujours : le suivi des déploiements tourne sans session.
    return { baseUrl: credential.base_url, apiKey: await ctx.secure.open.decrypt(credential.secret_enc) };
}

export const projectDeployGetFeature: FeatureDefinition<
    typeof projectDeployGet.command,
    typeof projectDeployGet.input,
    typeof projectDeployGet.output
> = defineFeature({
    ...projectDeployGet,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const row = await ctx.db.projectDeploy.findTarget(input.projectId, ctx.workspaceId);
        if (!row) return { target: null };
        return { target: await toTarget(cipherFor(ctx, project.security_tier), row) };
    }
});

export const projectDeployCandidatesFeature: FeatureDefinition<
    typeof projectDeployCandidates.command,
    typeof projectDeployCandidates.input,
    typeof projectDeployCandidates.output
> = defineFeature({
    ...projectDeployCandidates,
    access: WRITE,
    handler: async (ctx, input) => {
        const { baseUrl, apiKey } = await loadDokployCredential(ctx, input.credentialId);
        try {
            const apps = await listApplications(baseUrl, apiKey);
            return { candidates: apps.map((a) => ({ externalId: a.externalId, name: a.name, path: a.path })) };
        } catch (e) {
            throw new FeatureError('internal', e instanceof Error ? e.message : 'Instance Dokploy injoignable.');
        }
    }
});

export const projectDeployLinkFeature: FeatureDefinition<
    typeof projectDeployLink.command,
    typeof projectDeployLink.input,
    typeof projectDeployLink.output
> = defineFeature({
    ...projectDeployLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        // Même règle que le dépôt git : le suivi tourne sans session et
        // n'atteindra jamais l'étage gardé.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être relié à un déploiement : le suivi tourne sans session.'
            );
        }
        await loadDokployCredential(ctx, input.credentialId);

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.db.projectDeploy.upsertTarget({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            credentialId: input.credentialId,
            provider: 'dokploy',
            externalId: input.externalId,
            content: await cipher.encrypt(JSON.stringify({ name: input.name }))
        });
        ctx.audit({
            action: 'project.deployLink',
            description: 'Application de déploiement liée',
            metadata: { projectId: input.projectId, externalId: input.externalId }
        });
        return { target: await toTarget(cipher, row) };
    }
});

export const projectDeployUnlinkFeature: FeatureDefinition<
    typeof projectDeployUnlink.command,
    typeof projectDeployUnlink.input,
    typeof projectDeployUnlink.output
> = defineFeature({
    ...projectDeployUnlink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        const ok = await ctx.db.projectDeploy.deleteTarget(input.projectId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Aucune application liée');
        return { projectId: input.projectId };
    }
});

export const projectDeployTriggerFeature: FeatureDefinition<
    typeof projectDeployTrigger.command,
    typeof projectDeployTrigger.input,
    typeof projectDeployTrigger.output
> = defineFeature({
    ...projectDeployTrigger,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        const target = await ctx.db.projectDeploy.findTarget(input.projectId, ctx.workspaceId);
        if (!target) throw new FeatureError('not_found', 'Aucune application liée');
        if (target.credential_id === null) {
            throw new FeatureError('validation', 'L’accès Dokploy a été retiré : reliez un identifiant.');
        }
        const { baseUrl, apiKey } = await loadDokployCredential(ctx, target.credential_id);

        const cipher = cipherFor(ctx, project.security_tier);
        const title = input.title || 'Déploiement depuis DevEye';

        // La ligne est écrite **avant** l'appel : si le fournisseur accepte puis
        // que la réponse se perd, il reste une trace de ce qui a été déclenché.
        // Un déploiement fantôme est moins grave qu'un déploiement invisible.
        const row = await ctx.db.projectDeploy.createDeployment({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            provider: 'dokploy',
            externalId: null,
            triggeredByUserId: ctx.userId,
            content: await cipher.encrypt(JSON.stringify({ title, description: input.description, url: baseUrl }))
        });

        // Audité en `warn` : c'est la seule action du module qui produise un
        // effet hors de DevEye.
        ctx.audit({
            level: 'warning',
            action: 'project.deployTrigger',
            description: `Déploiement déclenché : ${title}`,
            metadata: { projectId: input.projectId, applicationId: target.external_id }
        });

        try {
            await triggerDeploy(baseUrl, apiKey, target.external_id, title, input.description);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Déclenchement refusé.';
            await ctx.db.projectDeploy.updateDeployment(row.id, {
                externalId: null,
                status: 'failed',
                finishedAt: Math.floor(Date.now() / 1000),
                content: await cipher.encrypt(
                    JSON.stringify({ title, description: `${input.description}\n${message}`.trim(), url: baseUrl })
                )
            });
            throw new FeatureError('internal', message);
        }

        await recordEvent(ctx, project, {
            kind: 'deploy.triggered',
            label: title
        });
        // Le suivi d'état est repris par l'ordonnanceur : c'est lui qui ira
        // demander à Dokploy où en est ce déploiement.
        ctx.projects?.requestSync(input.projectId);

        return { deployment: await toDeployment(cipher, row) };
    }
});

export const projectDeployListFeature: FeatureDefinition<
    typeof projectDeployList.command,
    typeof projectDeployList.input,
    typeof projectDeployList.output
> = defineFeature({
    ...projectDeployList,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);
        const rows = await ctx.db.projectDeploy.listDeployments(input.projectId, ctx.workspaceId, input.limit ?? 20);
        return { deployments: await Promise.all(rows.map((row) => toDeployment(cipher, row))) };
    }
});

export const projectDeployFeatures = [
    projectDeployGetFeature,
    projectDeployCandidatesFeature,
    projectDeployLinkFeature,
    projectDeployUnlinkFeature,
    projectDeployTriggerFeature,
    projectDeployListFeature
];
