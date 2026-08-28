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
 * Commandes des dépôts git de l'espace.
 *
 * Préfixe unique `git.`, comme `project.` — d'où le camelCase derrière le point.
 *
 * ⚠️ Conséquence à connaître : le filet de démarrage (`MUTATION_VERB` dans
 * `src/features/_topics.ts`) cherche un verbe **juste après le point**. Il ne
 * verra donc **aucune** de ces commandes, et un `mutates` oublié ne produira
 * aucun avertissement. Il se relit à la main.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS et
 * le dispatcheur le résout, appartenance vérifiée, avant le handler.
 */

const repoId = z.number().int().positive();
const credentialId = z.number().int().positive();

// ------------------------------------------------------------- identifiants

/**
 * Les jetons **GitHub** de l'espace.
 *
 * Ils vivent ici et non dans les projets : un même jeton ouvre en général
 * plusieurs dépôts. Les secrets n'en sortent jamais — la sortie ne porte qu'un
 * `hasSecret`.
 *
 * Les clés **Dokploy** ne sont plus ici : elles ont leur propre feature
 * (`deploy.credential*`). Elles n'avaient atterri dans cet écran que faute d'un
 * module de déploiement pour les accueillir, et poser la clé qui met en
 * production ne relève pas du droit de lire des dépôts. La table est restée
 * commune ; c'est la porte, et le droit, qui se sont séparés.
 */
export const gitCredentialList = {
    command: 'git.credentialList' as const,
    input: z.object({}),
    output: z.object({ credentials: z.array(gitCredentialSchema) })
};

/**
 * Aucun `provider` ni `baseUrl` en entrée : GitHub, et son API publique. Le
 * fournisseur se choisissait autrefois dans un sélecteur, parce que le même
 * écran servait les deux — il n'y a plus rien à choisir ici.
 */
export const gitCredentialAdd = {
    command: 'git.credentialAdd' as const,
    input: z.object({
        label: z.string().min(1).max(GIT_CREDENTIAL_LABEL_MAX_LENGTH),
        secret: z.string().min(1).max(GIT_CREDENTIAL_SECRET_MAX_LENGTH)
    }),
    output: z.object({ credential: gitCredentialSchema })
};

/**
 * Modifie un jeton. `secret` absent = on garde celui en place ; une chaîne non
 * vide le remplace. Il n'y a pas de « vider » : un accès sans secret ne sert à
 * rien, on retire le jeton entier.
 */
export const gitCredentialUpdate = {
    command: 'git.credentialUpdate' as const,
    input: z.object({
        credentialId,
        label: z.string().min(1).max(GIT_CREDENTIAL_LABEL_MAX_LENGTH),
        secret: z.string().min(1).max(GIT_CREDENTIAL_SECRET_MAX_LENGTH).optional()
    }),
    output: z.object({ credential: gitCredentialSchema })
};

/**
 * Retire un jeton.
 *
 * Les dépôts qui s'en servaient gardent leur lien mais perdent leur accès
 * (`ON DELETE SET NULL`) : la synchronisation s'arrête proprement et le dit, au
 * lieu de disparaître avec le jeton.
 */
export const gitCredentialRemove = {
    command: 'git.credentialRemove' as const,
    input: z.object({ credentialId }),
    output: z.object({ credentialId })
};

// -------------------------------------------------------------------- dépôts

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

/** Un dépôt, avec les projets qui s'en servent — tout doit être cliquable. */
export const gitRepoGet = {
    command: 'git.repoGet' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema, usage: z.array(gitRepoUsageSchema) })
};

/**
 * Ajoute un dépôt à l'espace.
 *
 * **Idempotente** : le même `owner/repo` déjà présent rend la ligne existante
 * (avec son jeton mis à jour) au lieu d'un doublon. C'est ce qui permet à un
 * projet de « créer » un dépôt sans savoir s'il existe déjà ailleurs, et
 * garantit qu'un dépôt n'est jamais synchronisé deux fois.
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
 * Les dépôts d'un propriétaire ou d'une organisation, chez le fournisseur.
 *
 * Interroge GitHub **au moment de la demande** — c'est, avec le diff d'un
 * commit, la seule commande du module dans ce cas. La liste dépend du jeton
 * choisi (un jeton donne accès aux dépôts privés, l'absence de jeton n'ouvre que
 * le public), d'où le `credentialId` en entrée : changer de jeton change le
 * résultat, et l'interface doit pouvoir le re-demander.
 */
export const gitRepoCandidates = {
    command: 'git.repoCandidates' as const,
    input: z.object({
        owner: z.string().min(1).max(GIT_REPO_OWNER_MAX_LENGTH),
        credentialId: credentialId.nullable()
    }),
    output: z.object({ repos: z.array(gitRepoCandidateSchema) })
};

/**
 * Range les dépôts de l'espace : `ids` est la liste **complète** dans son ordre
 * final (rang le plus faible en tête).
 *
 * Rien d'autre ne positionne un dépôt — un nouveau prend le rang suivant, donc
 * la fin de la liste — de sorte que l'ordre appartient entièrement à
 * l'utilisateur, comme celui des services surveillés et des notes. Ne touche ni
 * au cache ni à l'état de synchronisation : ranger n'est pas configurer.
 */
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

/**
 * Supprime un dépôt de l'espace, avec son cache et toutes ses liaisons.
 *
 * Les projets liés ne sont **pas** touchés : ils perdent leur dépôt, rien
 * d'autre. Le dépôt chez le fournisseur, lui, n'est évidemment jamais atteint.
 */
export const gitRepoRemove = {
    command: 'git.repoRemove' as const,
    input: z.object({ repoId }),
    output: z.object({ repoId })
};

/**
 * Force une synchronisation immédiate, sans attendre le tour de
 * l'ordonnanceur. N'écrit rien elle-même : elle réveille le service de fond.
 */
export const gitRepoSyncNow = {
    command: 'git.repoSyncNow' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema })
};

/**
 * Jette le cache local du dépôt et repart de zéro.
 *
 * À distinguer de `gitRepoSyncNow`, qui reprend là où le service s'était
 * arrêté : ici on efface commits, branches, releases et pull requests, ainsi que
 * les ETags et le drapeau de backfill, de sorte que le tour suivant relise
 * **tout** l'historique depuis le fournisseur.
 *
 * Deux choses survivent, et ce n'est pas un oubli :
 *
 *  - le **rattachement des auteurs** à des membres de l'espace, qui est du
 *    travail fait à la main et que rien ne permettrait de reconstituer ;
 *  - les **liaisons aux projets**, qui ne relèvent pas du cache.
 *
 * N'écrit rien elle-même côté fournisseur : elle vide, puis réveille
 * l'ordonnanceur.
 */
export const gitRepoResync = {
    command: 'git.repoResync' as const,
    input: z.object({ repoId }),
    output: z.object({ repo: gitRepoSchema })
};

/**
 * L'avancement de la synchronisation d'un dépôt.
 *
 * Lecture pure et **très bon marché** : elle n'interroge qu'une table en
 * mémoire du service de fond. C'est ce qui la rend sondable pendant qu'une
 * synchronisation tourne, sans passer par une diffusion `live` qui ferait
 * re-solliciter tout l'écran à chaque étape, chez tous les membres.
 */
export const gitRepoSyncStatus = {
    command: 'git.repoSyncStatus' as const,
    input: z.object({ repoId }),
    output: z.object({ status: gitSyncStatusSchema })
};

/**
 * Les synchronisations en cours dans l'espace, toutes d'un coup.
 *
 * **Aucune requête, aucun déchiffrement** : le service tient l'avancement en
 * mémoire le temps d'un tour. C'est ce qui rend la liste des dépôts sondable à
 * la seconde pour y animer une bande de progression, sans que cela coûte quoi
 * que ce soit — même parti pris que la barre d'une synchro mail.
 *
 * Un dépôt absent de la réponse ne synchronise pas : il n'y a pas d'entrée
 * « au repos », seulement celles qui tournent.
 */
export const gitSyncStatuses = {
    command: 'git.syncStatuses' as const,
    input: z.object({}),
    output: z.object({ statuses: z.array(gitRepoSyncStateSchema) })
};

// ------------------------------------------------------------------- lecture

export const gitBranchList = {
    command: 'git.branchList' as const,
    input: z.object({ repoId }),
    output: z.object({ branches: z.array(gitBranchSchema) })
};

/**
 * Les derniers commits, en clair, pour la liste (pas pour le graphe).
 *
 * Pagination par **curseur** `(committedAt, id)` et non par identifiant seul :
 * voir `gitCommitCursorSchema`. La page suivante se demande avec le couple porté
 * par le dernier commit reçu.
 */
export const gitCommitList = {
    command: 'git.commitList' as const,
    input: z.object({
        repoId,
        before: gitCommitCursorSchema.optional(),
        limit: z.number().int().positive().max(200).optional()
    }),
    output: z.object({ commits: z.array(gitCommitSchema), hasMore: z.boolean() })
};

/**
 * Le graphe : un point par commit, du premier au dernier, avec la liste des
 * auteurs et leur couleur.
 *
 * Les points ne portent **pas** les messages — un graphe en affiche des
 * milliers, et les déchiffrer tous pour dessiner des ronds serait absurde.
 */
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

/**
 * Le diff d'un commit, lu **chez le fournisseur au moment de la demande**.
 *
 * La seule commande du module qui sorte du cache local : voir
 * `gitCommitDetailSchema` pour la raison. Elle est donc aussi la seule dont la
 * latence dépend d'une API tierce — l'interface doit l'annoncer.
 */
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
