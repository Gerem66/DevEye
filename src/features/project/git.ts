import {
    projectAuthorMap,
    projectBranchList,
    projectCommitGraph,
    projectCommitList,
    projectCredentialAdd,
    projectCredentialList,
    projectCredentialRemove,
    projectCredentialUpdate,
    projectReleaseList,
    projectRepoGet,
    projectRepoLink,
    projectRepoSetEnabled,
    projectRepoSyncNow,
    projectRepoUnlink,
    USER_COLORS,
    defaultUserColor
} from 'deveye-types';
import type { ProjectCredential, ProjectCredentialRow, ProjectRepo, ProjectRepoRow, UserColor } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertProjectUnlocked, cipherFor, loadProject } from './_shared';

/**
 * Intégration git : identifiants d'accès, dépôt lié, et lecture du cache
 * alimenté par `ProjectSyncService`.
 *
 * Rien ici n'appelle GitHub directement — même `repoSyncNow` ne fait que
 * réveiller le service de fond. C'est ce qui garde une commande WS courte et
 * prévisible : aucune ne dépend de la latence d'une API tierce.
 *
 * ⚠️ Les secrets ne sortent **jamais** : les DTO ne portent qu'un `hasSecret`.
 */

const READ = { feature: 'projects' } as const;
const WRITE = { feature: 'projects', level: 'write' } as const;

/**
 * Les identifiants d'accès sont **toujours** sous l'étage ouvert, quel que soit
 * le tier des projets qui s'en servent : le service de fond doit les lire sans
 * session. Même raison que les réglages Uptime.
 */
function secretCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

function toCredential(row: ProjectCredentialRow): ProjectCredential {
    return {
        id: row.id,
        provider: row.provider === 'dokploy' ? 'dokploy' : 'github',
        label: row.label,
        baseUrl: row.base_url,
        hasSecret: row.secret_enc.length > 0,
        created: row.created
    };
}

async function toRepo(cipher: Cipher, row: ProjectRepoRow): Promise<ProjectRepo> {
    const target = await readJson<{ owner?: string; repo?: string }>(cipher, row.content);
    return {
        projectId: row.project_id,
        provider: row.provider === 'dokploy' ? 'dokploy' : 'github',
        owner: target?.owner ?? '',
        repo: target?.repo ?? '',
        credentialId: row.credential_id,
        enabled: row.enabled === 1,
        defaultBranch: row.default_branch,
        lastSyncAt: row.last_sync_at,
        lastSyncError: row.last_sync_error ? await cipher.tryDecrypt(row.last_sync_error) : null
    };
}

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

/** Teinte déterministe d'un auteur git non rattaché, dérivée de son empreinte. */
function colorForRef(ref: string): UserColor {
    let sum = 0;
    for (let i = 0; i < ref.length; i++) sum = (sum + ref.charCodeAt(i)) % 4096;
    return USER_COLORS[sum % USER_COLORS.length];
}

// ------------------------------------------------------------- identifiants

export const projectCredentialListFeature: FeatureDefinition<
    typeof projectCredentialList.command,
    typeof projectCredentialList.input,
    typeof projectCredentialList.output
> = defineFeature({
    ...projectCredentialList,
    access: READ,
    handler: async (ctx) => ({
        credentials: (await ctx.db.projectGit.listCredentials(ctx.workspaceId)).map(toCredential)
    })
});

export const projectCredentialAddFeature: FeatureDefinition<
    typeof projectCredentialAdd.command,
    typeof projectCredentialAdd.input,
    typeof projectCredentialAdd.output
> = defineFeature({
    ...projectCredentialAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.projectGit.createCredential({
            workspaceId: ctx.workspaceId,
            provider: input.provider,
            label: input.label,
            baseUrl: input.baseUrl,
            secretEnc: await secretCipher(ctx).encrypt(input.secret)
        });
        ctx.audit({
            action: 'project.credentialAdd',
            description: `Identifiant ${input.provider} ajouté`,
            metadata: { credentialId: row.id, provider: input.provider }
        });
        return { credential: toCredential(row) };
    }
});

export const projectCredentialUpdateFeature: FeatureDefinition<
    typeof projectCredentialUpdate.command,
    typeof projectCredentialUpdate.input,
    typeof projectCredentialUpdate.output
> = defineFeature({
    ...projectCredentialUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.projectGit.updateCredential(input.credentialId, ctx.workspaceId, {
            label: input.label,
            baseUrl: input.baseUrl,
            // Secret absent = inchangé. Le client ne l'a jamais reçu, il ne
            // peut donc pas le renvoyer à l'identique.
            secretEnc: input.secret ? await secretCipher(ctx).encrypt(input.secret) : undefined
        });
        if (!row) throw new FeatureError('not_found', 'Identifiant introuvable');
        return { credential: toCredential(row) };
    }
});

export const projectCredentialRemoveFeature: FeatureDefinition<
    typeof projectCredentialRemove.command,
    typeof projectCredentialRemove.input,
    typeof projectCredentialRemove.output
> = defineFeature({
    ...projectCredentialRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Les dépôts qui s'en servaient gardent leur lien mais perdent leur
        // accès (`ON DELETE SET NULL`) : la synchronisation s'arrête proprement
        // et le dit, au lieu de disparaître avec le jeton.
        const ok = await ctx.db.projectGit.deleteCredential(input.credentialId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Identifiant introuvable');
        ctx.audit({
            action: 'project.credentialRemove',
            description: 'Identifiant retiré',
            metadata: { credentialId: input.credentialId }
        });
        return { credentialId: input.credentialId };
    }
});

// -------------------------------------------------------------- dépôt lié

export const projectRepoGetFeature: FeatureDefinition<
    typeof projectRepoGet.command,
    typeof projectRepoGet.input,
    typeof projectRepoGet.output
> = defineFeature({
    ...projectRepoGet,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const row = await ctx.db.projectGit.findRepo(input.projectId, ctx.workspaceId);
        if (!row) return { repo: null };
        return { repo: await toRepo(cipherFor(ctx, project.security_tier), row) };
    }
});

export const projectRepoLinkFeature: FeatureDefinition<
    typeof projectRepoLink.command,
    typeof projectRepoLink.input,
    typeof projectRepoLink.output
> = defineFeature({
    ...projectRepoLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);

        // Un projet confidentiel ne se synchronise pas : le service de fond
        // tourne sans session et n'atteindra jamais l'étage gardé. Refus
        // explicite plutôt qu'un réglage qui ne ferait jamais rien.
        if (project.security_tier === 'guarded') {
            throw new FeatureError(
                'validation',
                'Un projet confidentiel ne peut pas être synchronisé avec un dépôt : la synchronisation tourne sans session.'
            );
        }

        if (input.credentialId !== null) {
            const credential = await ctx.db.projectGit.findCredential(input.credentialId, ctx.workspaceId);
            if (!credential) throw new FeatureError('not_found', 'Identifiant introuvable');
            if (credential.provider !== input.provider) {
                throw new FeatureError('validation', 'Cet identifiant ne correspond pas au fournisseur choisi.');
            }
        }

        const cipher = cipherFor(ctx, project.security_tier);
        const row = await ctx.db.projectGit.upsertRepo({
            projectId: input.projectId,
            workspaceId: ctx.workspaceId,
            provider: input.provider,
            credentialId: input.credentialId,
            content: await cipher.encrypt(JSON.stringify({ owner: input.owner, repo: input.repo }))
        });
        ctx.audit({
            action: 'project.repoLink',
            description: 'Dépôt lié au projet',
            metadata: { projectId: input.projectId, provider: input.provider }
        });
        // Première lecture tout de suite : attendre deux minutes pour voir
        // apparaître quoi que ce soit donnerait l'impression que ça n'a pas
        // fonctionné.
        ctx.projects?.requestSync(input.projectId);
        return { repo: await toRepo(cipher, row) };
    }
});

export const projectRepoUnlinkFeature: FeatureDefinition<
    typeof projectRepoUnlink.command,
    typeof projectRepoUnlink.input,
    typeof projectRepoUnlink.output
> = defineFeature({
    ...projectRepoUnlink,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const ok = await ctx.db.projectGit.deleteRepo(input.projectId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Aucun dépôt lié');
        return { projectId: input.projectId };
    }
});

export const projectRepoSetEnabledFeature: FeatureDefinition<
    typeof projectRepoSetEnabled.command,
    typeof projectRepoSetEnabled.input,
    typeof projectRepoSetEnabled.output
> = defineFeature({
    ...projectRepoSetEnabled,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const row = await ctx.db.projectGit.setRepoEnabled(input.projectId, ctx.workspaceId, input.enabled);
        if (!row) throw new FeatureError('not_found', 'Aucun dépôt lié');
        return { repo: await toRepo(cipherFor(ctx, project.security_tier), row) };
    }
});

export const projectRepoSyncNowFeature: FeatureDefinition<
    typeof projectRepoSyncNow.command,
    typeof projectRepoSyncNow.input,
    typeof projectRepoSyncNow.output
> = defineFeature({
    ...projectRepoSyncNow,
    // Pas de `mutates` : cette commande n'écrit rien elle-même, elle réveille
    // l'ordonnanceur. C'est lui qui diffusera quand il aura écrit.
    access: WRITE,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        const row = await ctx.db.projectGit.findRepo(input.projectId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Aucun dépôt lié');
        if (!ctx.projects) throw new FeatureError('internal', 'Service de synchronisation indisponible');
        ctx.projects.requestSync(input.projectId);
        return { repo: await toRepo(cipherFor(ctx, project.security_tier), row) };
    }
});

// ------------------------------------------------------------- lecture

export const projectBranchListFeature: FeatureDefinition<
    typeof projectBranchList.command,
    typeof projectBranchList.input,
    typeof projectBranchList.output
> = defineFeature({
    ...projectBranchList,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);
        const rows = await ctx.db.projectGit.listBranches(input.projectId, ctx.workspaceId);
        const branches = await Promise.all(
            rows.map(async (row) => ({
                id: row.id,
                name: (await readJson<{ name?: string }>(cipher, row.content))?.name ?? '',
                headSha: row.head_sha,
                isDefault: row.is_default === 1,
                updatedAt: row.updated_at
            }))
        );
        return { branches };
    }
});

export const projectCommitListFeature: FeatureDefinition<
    typeof projectCommitList.command,
    typeof projectCommitList.input,
    typeof projectCommitList.output
> = defineFeature({
    ...projectCommitList,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);

        const limit = input.limit ?? 50;
        const rows = await ctx.db.projectGit.listCommits(
            input.projectId,
            ctx.workspaceId,
            input.before ?? null,
            limit + 1
        );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const authors = new Map(
            (await ctx.db.projectGit.listAuthors(input.projectId, ctx.workspaceId)).map((a) => [a.author_ref, a])
        );

        const commits = await Promise.all(
            page.map(async (row) => {
                const body = await readJson<{ message?: string; authorName?: string; url?: string }>(
                    cipher,
                    row.content
                );
                let parentCount = 0;
                try {
                    parentCount = row.parents ? (JSON.parse(row.parents) as string[]).length : 0;
                } catch {
                    parentCount = 0;
                }
                return {
                    id: row.id,
                    sha: row.sha,
                    message: body?.message ?? '',
                    authorName: body?.authorName ?? '',
                    authorRef: row.author_ref,
                    authorUserId: authors.get(row.author_ref)?.user_id ?? null,
                    url: body?.url ?? null,
                    committedAt: Number(row.committed_at),
                    parentCount
                };
            })
        );
        return { commits, hasMore };
    }
});

/** Au-delà, le graphe agrège plutôt que de transporter un point par commit. */
const GRAPH_MAX_POINTS = 5000;

export const projectCommitGraphFeature: FeatureDefinition<
    typeof projectCommitGraph.command,
    typeof projectCommitGraph.input,
    typeof projectCommitGraph.output
> = defineFeature({
    ...projectCommitGraph,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);

        // Les points ne coûtent aucun déchiffrement : ce sont trois colonnes
        // claires. C'est tout l'intérêt d'avoir gardé `committed_at` et
        // `author_ref` en clair.
        const [points, stats, counts, authorRows] = await Promise.all([
            ctx.db.projectGit.listCommitPoints(input.projectId, ctx.workspaceId, GRAPH_MAX_POINTS),
            ctx.db.projectGit.commitStats(input.projectId, ctx.workspaceId),
            ctx.db.projectGit.authorStats(input.projectId, ctx.workspaceId),
            ctx.db.projectGit.listAuthors(input.projectId, ctx.workspaceId)
        ]);

        const countByRef = new Map(counts.map((c) => [c.author_ref, c.commit_count]));
        // Un seul aller-retour pour les comptes rattachés, plutôt qu'un par
        // auteur : la liste est courte et déjà connue.
        const linkedIds = [...new Set(authorRows.map((a) => a.user_id).filter((id): id is number => id !== null))];
        const members = new Map(
            (linkedIds.length > 0 ? await ctx.db.users.findByIds(linkedIds) : []).map((u) => [u.id, u.color])
        );

        const authors = await Promise.all(
            authorRows.map(async (row) => {
                const body = await readJson<{ name?: string; email?: string }>(cipher, row.content);
                // Un auteur rattaché prend la couleur de son compte — la même
                // que sa présence en direct, pour qu'une personne n'ait qu'une
                // seule couleur dans toute l'application. `users.color` peut
                // être vide sur un compte jamais colorié : on retombe alors sur
                // la couleur dérivée de son identifiant, comme partout ailleurs.
                const stored = row.user_id !== null ? members.get(row.user_id) : undefined;
                const color =
                    row.user_id !== null ? stored || defaultUserColor(row.user_id) : colorForRef(row.author_ref);
                return {
                    authorRef: row.author_ref,
                    name: body?.name ?? '',
                    email: body?.email ?? '',
                    userId: row.user_id,
                    color,
                    commitCount: countByRef.get(row.author_ref) ?? 0
                };
            })
        );

        return {
            points: points.map((p) => ({ sha: p.sha, committedAt: p.committed_at, authorRef: p.author_ref })),
            authors,
            firstCommitAt: stats.firstAt,
            lastCommitAt: stats.lastAt,
            total: stats.total
        };
    }
});

export const projectAuthorMapFeature: FeatureDefinition<
    typeof projectAuthorMap.command,
    typeof projectAuthorMap.input,
    typeof projectAuthorMap.output
> = defineFeature({
    ...projectAuthorMap,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await loadProject(ctx, input.projectId);
        if (input.userId !== null && !(await ctx.db.workspaceMembers.isMember(input.userId, ctx.workspaceId))) {
            throw new FeatureError('validation', 'Cette personne n’est pas membre de cet espace.');
        }
        const ok = await ctx.db.projectGit.setAuthorUser(
            input.projectId,
            ctx.workspaceId,
            input.authorRef,
            input.userId
        );
        if (!ok) throw new FeatureError('not_found', 'Auteur introuvable');
        return { authorRef: input.authorRef, userId: input.userId };
    }
});

export const projectReleaseListFeature: FeatureDefinition<
    typeof projectReleaseList.command,
    typeof projectReleaseList.input,
    typeof projectReleaseList.output
> = defineFeature({
    ...projectReleaseList,
    access: READ,
    handler: async (ctx, input) => {
        const project = await loadProject(ctx, input.projectId);
        await assertProjectUnlocked(ctx, project);
        const cipher = cipherFor(ctx, project.security_tier);
        const rows = await ctx.db.projectGit.listReleases(input.projectId, ctx.workspaceId);
        const releases = await Promise.all(
            rows.map(async (row) => {
                const body = await readJson<{ tag?: string; name?: string; body?: string; url?: string }>(
                    cipher,
                    row.content
                );
                return {
                    id: row.id,
                    tag: body?.tag ?? '',
                    name: body?.name ?? '',
                    body: body?.body ?? '',
                    url: body?.url || null,
                    publishedAt: Number(row.published_at),
                    isPrerelease: row.is_prerelease === 1
                };
            })
        );
        return { releases };
    }
});

export const projectGitFeatures = [
    projectCredentialListFeature,
    projectCredentialAddFeature,
    projectCredentialUpdateFeature,
    projectCredentialRemoveFeature,
    projectRepoGetFeature,
    projectRepoLinkFeature,
    projectRepoUnlinkFeature,
    projectRepoSetEnabledFeature,
    projectRepoSyncNowFeature,
    projectBranchListFeature,
    projectCommitListFeature,
    projectCommitGraphFeature,
    projectAuthorMapFeature,
    projectReleaseListFeature
];
