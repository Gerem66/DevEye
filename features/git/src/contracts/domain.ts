import { z } from 'zod';
import { projectStatusSchema, userColorSchema } from '@deveye/types';

/**
 * Les dépôts git d'un espace, et le cache local de ce qu'on y a lu. Un dépôt
 * appartient à l'espace, pas à un projet (qui n'en garde qu'une liaison), donc
 * toujours à l'étage ouvert : le service de fond le lit sans session. Le cache
 * n'est pas la source de vérité. `sha`, `committed_at`, `author_ref` et les
 * horodatages restent en clair (le graphe se calcule en SQL) ; le reste est chiffré.
 */

export const GIT_REPO_OWNER_MAX_LENGTH = 100;
export const GIT_REPO_NAME_MAX_LENGTH = 100;

/** Un seul fournisseur ; l'énumération épargne au second de réécrire le contrat. */
export const gitProviderSchema = z.enum(['github']);
export type GitProvider = z.infer<typeof gitProviderSchema>;

export const gitRepoSchema = z.object({
    id: z.number().int().positive(),
    provider: gitProviderSchema,
    owner: z.string().max(GIT_REPO_OWNER_MAX_LENGTH),
    repo: z.string().max(GIT_REPO_NAME_MAX_LENGTH),
    credentialId: z.number().int().positive().nullable(),
    enabled: z.boolean(),
    defaultBranch: z.string().nullable(),
    lastSyncAt: z.number().int().nullable(),
    /** Message du dernier échec, ou `null` après un succès. */
    lastSyncError: z.string().nullable(),
    /** Combien de projets s'en servent : ce qu'une suppression va couper. */
    projectCount: z.number().int().nonnegative(),
    /** Cet élément vient d'un autre espace, qui le projette ici. */
    foreign: z.boolean(),
    /** L'offre de son propriétaire le tient en pause : plus rien ne se synchronise, `enabled` reste intact. */
    planPaused: z.boolean(),
    created: z.number().int()
});
export type GitRepo = z.infer<typeof gitRepoSchema>;

/** Un dépôt proposé au choix, lu chez le fournisseur à la demande, jamais en cache. */
export const gitRepoCandidateSchema = z.object({
    name: z.string(),
    /** Un dépôt privé n'est visible qu'avec un jeton. */
    private: z.boolean(),
    archived: z.boolean(),
    description: z.string(),
    pushedAt: z.number().int().nullable(),
    /** Déjà présent dans l'espace : on le signale plutôt que de le masquer. */
    known: z.boolean()
});
export type GitRepoCandidate = z.infer<typeof gitRepoCandidateSchema>;

/** Un projet qui utilise ce dépôt ; à l'étage ouvert, donc lisible sans session. */
export const gitRepoUsageSchema = z.object({
    projectId: z.number().int().positive(),
    title: z.string(),
    status: projectStatusSchema
});
export type GitRepoUsage = z.infer<typeof gitRepoUsageSchema>;

export const gitBranchSchema = z.object({
    id: z.number().int().positive(),
    name: z.string(),
    headSha: z.string().nullable(),
    isDefault: z.boolean(),
    updatedAt: z.number().int().nullable(),
    /**
     * Avance et retard sur la branche par défaut ; `null` (et non zéro) quand
     * la comparaison n'a pas eu lieu.
     */
    aheadCount: z.number().int().nonnegative().nullable(),
    behindCount: z.number().int().nonnegative().nullable()
});
export type GitBranch = z.infer<typeof gitBranchSchema>;

/**
 * GitHub ne distingue pas « fusionnée » de « fermée » dans `state` : on les
 * sépare ici, et `draft` devient un état.
 */
export const gitPullStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);
export type GitPullState = z.infer<typeof gitPullStateSchema>;

export const gitPullRequestSchema = z.object({
    id: z.number().int().positive(),
    /** Numéro public : l'identité stable chez le fournisseur. */
    number: z.number().int().positive(),
    state: gitPullStateSchema,
    title: z.string(),
    body: z.string(),
    authorName: z.string(),
    headBranch: z.string(),
    baseBranch: z.string(),
    url: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    mergedAt: z.number().int().nullable(),
    closedAt: z.number().int().nullable()
});
export type GitPullRequest = z.infer<typeof gitPullRequestSchema>;

export const gitDiffStatusSchema = z
    .enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'])
    // Un état inconnu dégrade l'affichage, il ne fait pas échouer la lecture.
    .catch('modified');
export type GitDiffStatus = z.infer<typeof gitDiffStatusSchema>;

export const gitDiffFileSchema = z.object({
    filename: z.string(),
    /** Ancien chemin d'un fichier renommé, sinon `null`. */
    previousFilename: z.string().nullable(),
    status: gitDiffStatusSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** `null` pour un binaire ou un fichier trop gros pour le fournisseur. */
    patch: z.string().nullable()
});
export type GitDiffFile = z.infer<typeof gitDiffFileSchema>;

/**
 * Le diff d'un commit, jamais mis en cache : il pèse des ordres de grandeur de
 * plus que sa ligne et ne se regarde qu'une fois.
 */
export const gitCommitDetailSchema = z.object({
    sha: z.string(),
    message: z.string(),
    authorName: z.string(),
    committedAt: z.number().int(),
    url: z.string().nullable(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(gitDiffFileSchema),
    /** Le fournisseur a écrêté la liste (au-delà de 300 fichiers). */
    truncated: z.boolean()
});
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;

/**
 * L'avancement d'un dépôt en cours de synchronisation, compté en étapes et non
 * en objets : on ignore combien de commits le distant va rendre.
 */
export const gitRepoSyncStateSchema = z.object({
    repoId: z.number().int().positive(),
    phase: z.string(),
    step: z.number().int().nonnegative(),
    stepCount: z.number().int().positive()
});
export type GitRepoSyncState = z.infer<typeof gitRepoSyncStateSchema>;

export const gitSyncStatusSchema = z.object({
    running: z.boolean(),
    phase: z.string().nullable(),
    step: z.number().int().nonnegative(),
    stepCount: z.number().int().positive(),
    startedAt: z.number().int().nullable()
});
export type GitSyncStatus = z.infer<typeof gitSyncStatusSchema>;

export const gitCommitSchema = z.object({
    id: z.number().int().positive(),
    sha: z.string(),
    message: z.string(),
    authorName: z.string(),
    authorRef: z.string(),
    /** Membre de l'espace rattaché à cet auteur git, s'il l'a été. */
    authorUserId: z.number().int().positive().nullable(),
    url: z.string().nullable(),
    committedAt: z.number().int(),
    /** Plus d'un parent = une fusion. */
    parentCount: z.number().int().nonnegative()
});
export type GitCommit = z.infer<typeof gitCommitSchema>;

/**
 * Un auteur git et son rattachement éventuel. `color` : celle du membre s'il
 * est rattaché, sinon une teinte déterministe dérivée de `authorRef`.
 */
export const gitCommitAuthorSchema = z.object({
    authorRef: z.string(),
    name: z.string(),
    email: z.string(),
    userId: z.number().int().positive().nullable(),
    color: userColorSchema,
    commitCount: z.number().int().nonnegative()
});
export type GitCommitAuthor = z.infer<typeof gitCommitAuthorSchema>;

/** Longueur des sha abrégés du graphe (voir `gitCommitPointsSchema`). */
export const GIT_GRAPH_SHA_LEN = 12;

/**
 * Les points du graphe en colonnes parallèles, sans message : à 20 000 commits,
 * un tableau d'objets pèse ~2 Mo de JSON et autant d'allocations, trois
 * colonnes ~450 Ko. `shas` : les sha abrégés concaténés (`GIT_GRAPH_SHA_LEN`
 * chacun) ; `authorIndex` : un indice dans `authors`.
 */
export const gitCommitPointsSchema = z.object({
    /** La longueur commune des trois colonnes. */
    count: z.number().int().nonnegative(),
    shas: z.string(),
    committedAt: z.array(z.number().int()),
    authorIndex: z.array(z.number().int().nonnegative())
});
export type GitCommitPoints = z.infer<typeof gitCommitPointsSchema>;

/**
 * Le curseur de pagination : le couple `(committedAt, id)`, clé de tri de la
 * liste. `id` seul suit l'ordre d'insertion, pas l'ordre chronologique.
 */
export const gitCommitCursorSchema = z.object({
    committedAt: z.number().int(),
    id: z.number().int().positive()
});
export type GitCommitCursor = z.infer<typeof gitCommitCursorSchema>;

export const gitReleaseSchema = z.object({
    id: z.number().int().positive(),
    tag: z.string(),
    name: z.string(),
    body: z.string(),
    url: z.string().nullable(),
    publishedAt: z.number().int(),
    isPrerelease: z.boolean()
});
export type GitRelease = z.infer<typeof gitReleaseSchema>;

/** Ligne SQL (serveur uniquement). */
export interface GitRepoRow {
    id: number;
    workspace_id: number;
    credential_id: number | null;
    provider: string;
    /** Condensé de `owner/repo` en minuscules : porte l'unicité dans l'espace. */
    slug_ref: string;
    enabled: number;
    default_branch: string | null;
    last_sync_at: number | null;
    last_sync_error: string | null;
    sync_state: string | null;
    /** Rang dans la liste, entièrement défini par l'utilisateur (`git.repoReorder`). */
    sort_order: number;
    content: string;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface GitCommitRow {
    id: number;
    repo_id: number;
    workspace_id: number;
    sha: string;
    committed_at: number;
    author_ref: string;
    parents: string | null;
    content: string;
}

/** Ligne SQL (serveur uniquement). */
export interface GitCommitAuthorRow {
    id: number;
    repo_id: number;
    author_ref: string;
    workspace_id: number;
    user_id: number | null;
    content: string;
    created: number;
}

/** Ligne SQL (serveur uniquement). */
export interface GitBranchRow {
    id: number;
    repo_id: number;
    workspace_id: number;
    name_ref: string;
    head_sha: string | null;
    ahead_count: number | null;
    behind_count: number | null;
    /** `base..tête` au moment du calcul : dit si les compteurs valent encore. */
    compared_sha: string | null;
    is_default: number;
    updated_at: number | null;
    content: string;
}

/** Ligne SQL (serveur uniquement). */
export interface GitPullRequestRow {
    id: number;
    repo_id: number;
    workspace_id: number;
    number: number;
    state: string;
    author_ref: string | null;
    created_at: number;
    updated_at: number;
    merged_at: number | null;
    closed_at: number | null;
    content: string;
}

/** Ligne SQL (serveur uniquement). */
export interface GitReleaseRow {
    id: number;
    repo_id: number;
    workspace_id: number;
    tag_ref: string;
    published_at: number;
    is_prerelease: number;
    content: string;
}

/**
 * Les jetons GitHub de l'espace. Le secret ne sort jamais (`hasSecret` seulement),
 * toujours chiffré à l'étage ouvert : la synchronisation tourne sans session.
 */
export const GIT_CREDENTIAL_LABEL_MAX_LENGTH = 64;
export const GIT_CREDENTIAL_SECRET_MAX_LENGTH = 512;

export const gitCredentialSchema = z.object({
    id: z.number().int().positive(),
    label: z.string().max(GIT_CREDENTIAL_LABEL_MAX_LENGTH),
    hasSecret: z.boolean(),
    created: z.number().int(),
    /** Combien de dépôts s'en servent : ce qu'une suppression va couper. */
    useCount: z.number().int().nonnegative()
});
export type GitCredential = z.infer<typeof gitCredentialSchema>;

/** Ligne SQL (serveur uniquement). */
export interface GitCredentialRow {
    id: number;
    workspace_id: number;
    label: string;
    secret_enc: string;
    created: number;
}
