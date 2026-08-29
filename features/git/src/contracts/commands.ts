import { z } from 'zod';
import {
    GIT_REPO_NAME_MAX_LENGTH,
    GIT_REPO_OWNER_MAX_LENGTH,
    gitBranchSchema,
    gitCommitAuthorSchema,
    gitCommitDetailSchema,
    gitCommitCursorSchema,
    gitCommitPointsSchema,
    gitCommitSchema,
    gitRepoCandidateSchema,
    gitProviderSchema,
    gitPullRequestSchema,
    gitReleaseSchema,
    gitRepoSchema,
    gitRepoSyncStateSchema,
    gitRepoUsageSchema,
    gitSyncStatusSchema,
    GIT_CREDENTIAL_LABEL_MAX_LENGTH,
    GIT_CREDENTIAL_SECRET_MAX_LENGTH,
    gitCredentialSchema
} from './domain';

/**
 * Commandes des dépôts git de l'espace, préfixe `git.` en camelCase.
 *
 * Piège : le filet de démarrage (`MUTATION_VERB` dans `src/features/_topics.ts`)
 * cherche un verbe juste après le point et ne verra aucune de ces commandes ;
 * un `mutates` oublié ne produit aucun avertissement. L'espace visé voyage sur
 * l'enveloppe WS, jamais en entrée.
 */

const repoId = z.number().int().positive();
const credentialId = z.number().int().positive();

/** Les jetons GitHub de l'espace ; les secrets n'en sortent jamais. */
export const gitCredentialList = {
    command: 'git.credentialList' as const,
    input: z.object({}),
    output: z.object({ credentials: z.array(gitCredentialSchema) })
};

export const gitCredentialAdd = {
    command: 'git.credentialAdd' as const,
    input: z.object({
        label: z.string().min(1).max(GIT_CREDENTIAL_LABEL_MAX_LENGTH),
        secret: z.string().min(1).max(GIT_CREDENTIAL_SECRET_MAX_LENGTH)
    }),
    output: z.object({ credential: gitCredentialSchema })
};

/** `secret` absent = on garde celui en place ; pas de « vider », on retire le jeton entier. */
export const gitCredentialUpdate = {
    command: 'git.credentialUpdate' as const,
    input: z.object({
        credentialId,
        label: z.string().min(1).max(GIT_CREDENTIAL_LABEL_MAX_LENGTH),
        secret: z.string().min(1).max(GIT_CREDENTIAL_SECRET_MAX_LENGTH).optional()
    }),
    output: z.object({ credential: gitCredentialSchema })
};

/** Les dépôts qui s'en servaient restent, sans jeton : la synchronisation s'arrête et le dit. */
export const gitCredentialRemove = {
    command: 'git.credentialRemove' as const,
    input: z.object({ credentialId }),
    output: z.object({ credentialId })
};

/** Le nombre de dépôts de l'espace, pour la tuile de l'accueil. */
export const gitCount = {
    command: 'git.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

export const gitRepoList = {
    command: 'git.repoList' as const,
    input: z.object({}),
    output: z.object({ repos: z.array(gitRepoSchema) })
};

/** Un dépôt, avec les projets qui s'en servent. */
export const gitRepoGet = {
    command: 'git.repoGet' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema, usage: z.array(gitRepoUsageSchema) })
};

/**
 * Idempotente : un `owner/repo` déjà présent rend la ligne existante, jeton mis
 * à jour, au lieu d'un doublon.
 */
export const gitRepoAdd = {
    command: 'git.repoAdd' as const,
    input: z.object({
        provider: gitProviderSchema,
        owner: z.string().min(1).max(GIT_REPO_OWNER_MAX_LENGTH),
        repo: z.string().min(1).max(GIT_REPO_NAME_MAX_LENGTH),
        credentialId: credentialId.nullable()
    }),
    output: z.object({ repo: gitRepoSchema })
};

/**
 * Les dépôts d'un propriétaire, lus chez GitHub à la demande. La liste dépend
 * du jeton (privés compris), d'où `credentialId` en entrée.
 */
export const gitRepoCandidates = {
    command: 'git.repoCandidates' as const,
    input: z.object({
        owner: z.string().min(1).max(GIT_REPO_OWNER_MAX_LENGTH),
        credentialId: credentialId.nullable()
    }),
    output: z.object({ repos: z.array(gitRepoCandidateSchema) })
};

/** `ids` est la liste complète dans son ordre final. Ne touche ni au cache ni à la synchronisation. */
export const gitRepoReorder = {
    command: 'git.repoReorder' as const,
    input: z.object({ ids: z.array(repoId).min(1) }),
    output: z.object({ ids: z.array(repoId) })
};

/** Change le jeton d'un dépôt, ou suspend sa synchronisation. */
export const gitRepoUpdate = {
    command: 'git.repoUpdate' as const,
    input: z.object({ repoId, credentialId: credentialId.nullable(), enabled: z.boolean() }),
    output: z.object({ repo: gitRepoSchema })
};

/** Supprime le dépôt, son cache et ses liaisons ; les projets liés ne perdent que leur dépôt. */
export const gitRepoRemove = {
    command: 'git.repoRemove' as const,
    input: z.object({ repoId }),
    output: z.object({ repoId })
};

/** Réveille le service de fond ; n'écrit rien elle-même. */
export const gitRepoSyncNow = {
    command: 'git.repoSyncNow' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema })
};

/**
 * Jette le cache (commits, branches, releases, pull requests, ETags, drapeau de
 * backfill) et réveille l'ordonnanceur pour tout relire. Le rattachement des
 * auteurs et les liaisons aux projets survivent.
 */
export const gitRepoResync = {
    command: 'git.repoResync' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema })
};

/** L'avancement d'un dépôt, lu en mémoire du service : sondable sans coût. */
export const gitRepoSyncStatus = {
    command: 'git.repoSyncStatus' as const,
    input: z.object({ repoId }),
    output: z.object({ status: gitSyncStatusSchema })
};

/** Les synchronisations en cours dans l'espace, en mémoire du service ; un dépôt absent ne tourne pas. */
export const gitSyncStatuses = {
    command: 'git.syncStatuses' as const,
    input: z.object({}),
    output: z.object({ statuses: z.array(gitRepoSyncStateSchema) })
};

export const gitBranchList = {
    command: 'git.branchList' as const,
    input: z.object({ repoId }),
    output: z.object({ branches: z.array(gitBranchSchema) })
};

/** Les commits pour la liste, paginés par curseur `(committedAt, id)` (voir `gitCommitCursorSchema`). */
export const gitCommitList = {
    command: 'git.commitList' as const,
    input: z.object({
        repoId,
        before: gitCommitCursorSchema.optional(),
        limit: z.number().int().positive().max(200).optional()
    }),
    output: z.object({ commits: z.array(gitCommitSchema), hasMore: z.boolean() })
};

/** Un point par commit, sans message, avec les auteurs et leur couleur. */
export const gitCommitGraph = {
    command: 'git.commitGraph' as const,
    input: z.object({ repoId }),
    output: z.object({
        points: gitCommitPointsSchema,
        authors: z.array(gitCommitAuthorSchema),
        /** Bornes réelles de l'historique, même si les points sont écrêtés. */
        firstCommitAt: z.number().int().nullable(),
        lastCommitAt: z.number().int().nullable(),
        total: z.number().int().nonnegative()
    })
};

/** Rattache un auteur git à un membre de l'espace (ou l'en détache). */
export const gitAuthorMap = {
    command: 'git.authorMap' as const,
    input: z.object({
        repoId,
        authorRef: z.string().min(1).max(32),
        userId: z.number().int().positive().nullable()
    }),
    output: z.object({ authorRef: z.string(), userId: z.number().int().positive().nullable() })
};

export const gitReleaseList = {
    command: 'git.releaseList' as const,
    input: z.object({ repoId }),
    output: z.object({ releases: z.array(gitReleaseSchema) })
};

export const gitPullRequestList = {
    command: 'git.pullRequestList' as const,
    input: z.object({ repoId }),
    output: z.object({ pullRequests: z.array(gitPullRequestSchema) })
};

/** Le diff d'un commit, lu chez le fournisseur à la demande (voir `gitCommitDetailSchema`). */
export const gitCommitDetail = {
    command: 'git.commitDetail' as const,
    input: z.object({ repoId, sha: z.string().min(7).max(40) }),
    output: z.object({ detail: gitCommitDetailSchema })
};

export const gitCommands = [
    gitCredentialList,
    gitCredentialAdd,
    gitCredentialUpdate,
    gitCredentialRemove,
    gitCount,
    gitRepoList,
    gitRepoGet,
    gitRepoAdd,
    gitRepoCandidates,
    gitRepoReorder,
    gitRepoUpdate,
    gitRepoRemove,
    gitRepoResync,
    gitRepoSyncNow,
    gitRepoSyncStatus,
    gitSyncStatuses,
    gitBranchList,
    gitCommitList,
    gitCommitGraph,
    gitAuthorMap,
    gitReleaseList,
    gitPullRequestList,
    gitCommitDetail
] as const;
