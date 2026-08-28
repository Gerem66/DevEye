import { z } from 'zod';
import { projectStatusSchema, userColorSchema } from '@deveye/types';

/**
 * Les dépôts git d'un espace, et le cache local de ce qu'on y a lu.
 *
 * **Un dépôt appartient à l'espace, pas à un projet.** C'est le renversement qui
 * fonde cette feature : le même dépôt sert souvent plusieurs projets, et le
 * modéliser comme une propriété de l'un d'eux le faisait synchroniser deux fois,
 * dans deux caches, sous deux quotas. Un projet n'en garde donc qu'une
 * **liaison** (`project_repo_links`), et délier n'efface jamais le dépôt.
 *
 * **Cache, et non source de vérité** : le dépôt distant fait foi. Ce qui est
 * stocké ici sert à afficher un graphe et un historique sans rappeler l'API à
 * chaque ouverture — et à respecter le quota du fournisseur.
 *
 * Découpage clair / chiffré : `sha`, `committed_at`, `author_ref` et les
 * horodatages restent en clair (c'est ce qui rend le graphe calculable en SQL),
 * les messages, noms de branches et identités d'auteur sont chiffrés.
 *
 * **Toujours à l'étage ouvert**, quel que soit le tier des projets qui s'y
 * rattachent : un dépôt est d'espace, il ne peut pas suivre le palier de
 * confidentialité de l'un d'eux, et le service de fond doit le lire sans
 * session. Corollaire : un projet confidentiel n'a pas de dépôt du tout.
 */

export const GIT_REPO_OWNER_MAX_LENGTH = 100;
export const GIT_REPO_NAME_MAX_LENGTH = 100;

/**
 * Fournisseurs de dépôts.
 *
 * Un seul, et l'énumération est là pour que le second n'ait pas à réécrire le
 * contrat. Elle couvrait aussi `dokploy` du temps où les jetons des deux
 * intégrations vivaient dans ce module : un dépôt Dokploy n'a jamais existé,
 * c'était le fournisseur d'un **jeton**, notion qui a désormais son propre
 * domaine (`domain/credential.ts`).
 */
export const gitProviderSchema = z.enum(['github']);
export type GitProvider = z.infer<typeof gitProviderSchema>;

/** Un dépôt de l'espace, et l'état de sa dernière synchronisation. */
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
    /**
     * Combien de projets s'en servent.
     *
     * En clair dans la liste plutôt que sur demande : c'est l'information qui
     * dit si supprimer ce dépôt casse quelque chose, et elle doit se lire avant
     * de cliquer, pas après.
     */
    projectCount: z.number().int().nonnegative(),
    /**
     * Cet élément vient d'un **autre espace**, qui le projette ici.
     *
     * L'écran le signale d'une pastille : sans elle, rien ne distingue une
     * ligne locale d'une fenêtre sur l'espace voisin — et les gestes réservés
     * au domicile (supprimer, re-partager) sembleraient cassés au lieu de
     * s'expliquer.
     */
    foreign: z.boolean(),
    created: z.number().int()
});
export type GitRepo = z.infer<typeof gitRepoSchema>;

/**
 * Un dépôt proposé au choix, lu **chez le fournisseur au moment où on le
 * demande** — comme le diff d'un commit, et pour la même raison : c'est une
 * liste qu'on regarde une fois, au moment d'ajouter un dépôt, et qui serait
 * périmée avant d'être relue si on la mettait en cache.
 */
export const gitRepoCandidateSchema = z.object({
    name: z.string(),
    /** Un dépôt privé n'est visible qu'avec un jeton : le dire évite « où est-il ? ». */
    private: z.boolean(),
    archived: z.boolean(),
    description: z.string(),
    pushedAt: z.number().int().nullable(),
    /** Déjà présent dans l'espace : on le signale plutôt que de le masquer. */
    known: z.boolean()
});
export type GitRepoCandidate = z.infer<typeof gitRepoCandidateSchema>;

/**
 * Un projet qui utilise ce dépôt.
 *
 * Ne remonte que des projets à l'étage ouvert — un projet confidentiel ne peut
 * pas être lié, donc le titre est toujours lisible sans session.
 */
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
     * Commits d'avance et de retard sur la branche par défaut.
     *
     * `null` — et non zéro — quand la comparaison n'a pas eu lieu : la branche
     * par défaut elle-même, ou un dépôt jamais comparé. Zéro veut dire « à
     * jour », ce qui est une affirmation ; l'absence n'en est pas une.
     */
    aheadCount: z.number().int().nonnegative().nullable(),
    behindCount: z.number().int().nonnegative().nullable()
});
export type GitBranch = z.infer<typeof gitBranchSchema>;

/**
 * L'issue d'une pull request.
 *
 * GitHub ne distingue pas « fusionnée » de « fermée » dans son champ `state` —
 * une PR fusionnée y est simplement `closed`. Or ce sont deux fins opposées :
 * on les sépare ici, et `draft` est promu au rang d'état parce que c'est ainsi
 * qu'on le lit dans une liste.
 */
export const gitPullStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);
export type GitPullState = z.infer<typeof gitPullStateSchema>;

export const gitPullRequestSchema = z.object({
    id: z.number().int().positive(),
    /** Numéro public de la PR : son identité stable chez le fournisseur. */
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

/** L'état d'un fichier dans un commit, tel que le fournisseur le qualifie. */
export const gitDiffStatusSchema = z
    .enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'])
    // Un fournisseur d'une autre version peut inventer un état : il dégrade
    // l'affichage, il ne fait pas échouer la lecture d'un commit.
    .catch('modified');
export type GitDiffStatus = z.infer<typeof gitDiffStatusSchema>;

export const gitDiffFileSchema = z.object({
    filename: z.string(),
    /** Ancien chemin d'un fichier renommé, sinon `null`. */
    previousFilename: z.string().nullable(),
    status: gitDiffStatusSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /**
     * Le diff unifié du fichier, tel que le fournisseur le rend.
     *
     * `null` pour un binaire, ou quand le fournisseur l'a tronqué parce qu'il
     * était trop gros — deux cas où il n'y a rien à colorer et où il vaut mieux
     * le dire que d'afficher un vide inexpliqué.
     */
    patch: z.string().nullable()
});
export type GitDiffFile = z.infer<typeof gitDiffFileSchema>;

/**
 * Le détail d'un commit : son diff.
 *
 * **Jamais mis en cache**, à la différence du reste de l'intégration git. Un
 * diff pèse des ordres de grandeur de plus que la ligne qui le résume, on ne le
 * regarde qu'une fois, et le stocker chiffré ferait grossir la base sans
 * contrepartie. C'est donc la seule lecture du module qui interroge le
 * fournisseur au moment où on la demande.
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
    /** `true` quand le fournisseur a écrêté la liste (au-delà de 300 fichiers). */
    truncated: z.boolean()
});
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;

/**
 * L'avancement d'une synchronisation en cours.
 *
 * Volontairement compté **en étapes** et non en objets : on ignore combien de
 * commits le distant va rendre avant de les avoir lus. Une barre qui progresse
 * par étapes nommées dit la vérité ; une barre calée sur un total deviné
 * mentirait.
 */
/**
 * L'avancement d'un dépôt dans la liste : le même, plus son identité.
 *
 * Rendu pour **tous** les dépôts en cours d'un coup, de sorte que la liste
 * puisse afficher une bande de progression par carte sans interroger chaque
 * dépôt séparément.
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
    /** Libellé de l'étape en cours, ou `null` hors synchronisation. */
    phase: z.string().nullable(),
    /** Étapes achevées, et total connu d'avance. */
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
 * Un auteur git repéré dans l'historique, et son rattachement éventuel.
 *
 * `color` est la couleur retenue pour le graphe : celle du membre quand il est
 * rattaché, sinon une teinte déterministe dérivée de `authorRef` — de sorte
 * qu'un même contributeur garde la même couleur d'une session à l'autre, même
 * sans compte DevEye.
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
 * Les points du graphe, en **colonnes parallèles** et non en tableau d'objets.
 *
 * Volontairement dépouillé — pas de message ici. Le graphe en affiche des
 * dizaines de milliers ; les faire voyager avec leur texte chiffré coûterait
 * autant de déchiffrements pour un rendu qui ne montre qu'un point.
 *
 * La forme colonnaire n'est pas de la coquetterie : à 20 000 commits, un tableau
 * d'objets `{ sha, committedAt, authorRef }` pèse ~2 Mo de JSON (les accolades,
 * les noms de champs et les guillemets répétés dominent la charge utile) et
 * oblige le client à allouer 20 000 objets. Trois colonnes tombent à ~450 Ko et
 * se parcourent sans allocation — c'est ce qui rend le dessin fluide.
 *
 *  - `shas` : les sha abrégés **concaténés**, `GIT_GRAPH_SHA_LEN` caractères
 *    chacun. Découpés à la demande, jamais tous d'un coup. Abrégés parce que le
 *    graphe n'en fait que deux usages — l'info-bulle, qui en montre sept, et
 *    l'ouverture d'un commit, que le fournisseur accepte abrégée.
 *  - `authorIndex` : un indice dans le tableau `authors` de la réponse, plutôt
 *    que l'empreinte de 16 caractères répétée à chaque point.
 */
export const gitCommitPointsSchema = z.object({
    /** Nombre de points transportés — la longueur commune des trois colonnes. */
    count: z.number().int().nonnegative(),
    shas: z.string(),
    committedAt: z.array(z.number().int()),
    authorIndex: z.array(z.number().int().nonnegative())
});
export type GitCommitPoints = z.infer<typeof gitCommitPointsSchema>;

/**
 * Le curseur de pagination des commits.
 *
 * Le couple `(committedAt, id)` et non `id` seul, parce que c'est **exactement**
 * la clé de tri de la liste. Les identifiants suivent l'ordre d'insertion, qui
 * est celui où le fournisseur a rendu les commits — pas leur ordre
 * chronologique. Paginer sur `id` alors qu'on trie par date sautait donc des
 * commits et en répétait d'autres, et la seconde page était souvent presque
 * vide : c'est ce qui donnait l'impression qu'on ne pouvait charger qu'une fois.
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

/** Ligne SQL (serveur uniquement) : la liaison projet → dépôt. */

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
 * Les jetons GitHub de l'espace.
 *
 * Ils vivaient dans `workspace_credentials`, une table à deux propriétaires
 * (jetons GitHub de Git, clés Dokploy de Déploiement, distingués par un
 * `provider`). Déploiement a emporté les siennes dans son module (099), Git
 * emporte les siens dans `ft_git_credentials` (migration 100 du socle, qui
 * supprime la table commune) : un module possède ses tables. Le contrat perd
 * son `provider` et son adresse d'instance : l'API GitHub est publique, il n'y
 * a pas d'instance à désigner.
 *
 * Le secret ne sort **jamais** : seule sa présence est annoncée (`hasSecret`).
 * Toujours chiffré à l'étage ouvert : la synchronisation tourne sans session.
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
