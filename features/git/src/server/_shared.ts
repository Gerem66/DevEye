import { createHash } from 'crypto';
import type { GitCredential, GitCredentialRow, GitRepo as GitRepoDto, GitRepoRow } from '../contracts/domain';
import { gitRepoSchema } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider, type ProjectUsage } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { GitRepo } from './repo';
import type { GitSync } from './service';

/**
 * Le socle de la feature Git.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** C'est la différence la plus
 * importante avec le module Projets, qui choisit son chiffre par projet : un
 * dépôt appartient à l'espace et peut servir plusieurs projets de paliers
 * différents, il ne peut donc suivre aucun d'eux. Corollaire pratique : rien
 * ici ne demande jamais de mot de passe, et le service de fond lit tout sans
 * session — ce qui est précisément ce dont il a besoin. `ctx.cipher()` est cet
 * étage (l'ex `ctx.secure.open`, que `gitCipher` enveloppait).
 */

/** Le contexte d'une commande de Git : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<GitRepo>;

/** Ce que porte `git_repos.content`, chiffré. */
export interface StoredRepo {
    owner: string;
    repo: string;
}

/**
 * L'identité d'un dépôt dans l'espace.
 *
 * Le chiffrement étant non déterministe, `content` ne peut porter aucune
 * contrainte d'unicité : deux chiffrés de `gerem66/DevEye` diffèrent. Ce
 * condensé la porte à sa place — même motif que `nameRef` pour les branches.
 * Insensible à la casse, parce que GitHub l'est.
 */
export function slugRef(owner: string, repo: string): string {
    return createHash('sha256')
        .update(`${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 16);
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: SdkCipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

/**
 * La synchronisation de fond du module, posée par `createService` au
 * démarrage : le remplaçant de la moitié git de l'`IntegrationSyncService`
 * natif, que `ctx.integrations` prêtait aux handlers. Un singleton d'étendue
 * module, assumé (patron `setEngine` de CloudSync) : l'ordonnanceur est unique
 * par processus, exactement comme avant le rapatriement.
 */
let syncRef: GitSync | null = null;

export function setSync(sync: GitSync | null): void {
    syncRef = sync;
}

/**
 * Le service de fond, s'il est monté.
 *
 * `null` hors service (tests, boot en cours), et chaque appelant dégrade comme
 * le faisait `ctx.integrations?.` : une demande de synchronisation attend le
 * prochain montage, un avancement se lit « rien en cours ».
 */
export function syncOf(): GitSync | null {
    return syncRef;
}

/**
 * Demande une synchronisation au service de fond, s'il est monté.
 *
 * Tolérant à son absence, comme l'était `ctx.integrations?.requestSync(id)` :
 * le dépôt sera pris au prochain tour de l'ordonnanceur, qui trie les jamais
 * synchronisés en tête.
 */
export function requestSync(repoId: number): void {
    syncRef?.requestSync(repoId);
}

/**
 * Charge un dépôt de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `repoId` commence par là, sans quoi elle répondrait sur le dépôt d'autrui.
 */
export async function loadRepo(ctx: Ctx, repoId: number, level: 'read' | 'write' = 'read'): Promise<GitRepoRow> {
    const row = await ctx.repo.findVisibleRepo(repoId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
    // `ctx.items.assert` (l'ex `assertItem`) refuse en plus les dépôts qu'une
    // restriction de rôle masque ou passe en lecture seule.
    await ctx.items.assert(repoId, level);
    return row;
}

/**
 * Comme {@link loadRepo}, mais exige que le dépôt soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : ses réglages (son jeton se choisit
 * parmi les clés d'ici) et sa suppression. Une fenêtre lit et resynchronise.
 */
export async function loadHomeRepo(ctx: Ctx, repoId: number): Promise<GitRepoRow> {
    const row = await loadRepo(ctx, repoId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Ce dépôt appartient à un autre espace : il se règle et se supprime depuis là-bas.'
        );
    }
    return row;
}

/**
 * Le codec du domicile d'un dépôt visible — celui d'ici pour un dépôt local.
 *
 * `ctx.sharing.scope()` est l'ex `shareScope(ctx, 'git')` : `cipherFor` ne
 * rend un codec étranger que si la projection existe réellement.
 */
export async function repoCipher(ctx: Ctx, repoId: number): Promise<SdkCipher> {
    return (await ctx.sharing.scope()).cipherFor(repoId);
}

export async function toRepo(
    cipher: SdkCipher,
    row: GitRepoRow,
    foreign: boolean,
    /** Le nombre de projets qui s'en servent, venu du contrat de Projets. */
    projectCount: number
): Promise<GitRepoDto> {
    const target = await readJson<Partial<StoredRepo>>(cipher, row.content);
    return gitRepoSchema.parse({
        foreign,
        id: row.id,
        provider: 'github',
        owner: target?.owner ?? '',
        repo: target?.repo ?? '',
        credentialId: row.credential_id,
        enabled: row.enabled === 1,
        defaultBranch: row.default_branch,
        lastSyncAt: row.last_sync_at,
        lastSyncError: row.last_sync_error ? await cipher.tryDecrypt(row.last_sync_error) : null,
        projectCount,
        created: row.created
    });
}

/**
 * Recharge un dépôt avec son compte d'usage, pour le rendre au client.
 *
 * Une requête de plus après chaque écriture, assumée : sans elle, `projectCount`
 * serait absent ou deviné, et la liste afficherait « 0 projet » sur un dépôt qui
 * en sert trois — un chiffre faux est pire qu'un aller-retour.
 */
export async function reloadRepo(ctx: Ctx, repoId: number): Promise<GitRepoDto> {
    const row = await ctx.repo.findVisibleRepo(repoId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
    const counts = await projectCountsOf(ctx);
    return toRepo(await repoCipher(ctx, row.id), row, row.workspace_id !== ctx.workspaceId, counts.get(repoId) ?? 0);
}

/**
 * Un jeton GitHub tel que le client le voit : jamais son secret, seulement sa
 * présence. Un secret qu'on ne renvoie pas est un secret qui ne peut fuiter ni
 * par une capture d'écran ni par un journal.
 */
export function toCredential(row: GitCredentialRow, useCount: number): GitCredential {
    return {
        id: row.id,
        label: row.label,
        hasSecret: row.secret_enc.length > 0,
        created: row.created,
        useCount
    };
}

/**
 * Le contrat de Projets, relu à l'appel : offert par l'app tant que Projets
 * était native, par son module depuis ; d'ici, aucune différence. Absent (rien
 * n'offre la clé), la feature dégrade proprement : zéro projet partout, aucune
 * commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace **appelant** utilisent chaque dépôt.
 *
 * Le module ne lit aucune table de Projets : le compte vient de son contrat,
 * et les projets comptés sont ceux d'ICI, les mêmes que `git.repoGet` liste
 * (un dépôt projeté montre les projets de la fenêtre, pas ceux de son
 * domicile).
 */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('git', ctx.workspaceId)) ?? new Map<number, number>();
}

/**
 * Les projets de l'espace appelant qui utilisent ce dépôt, avec leur titre :
 * c'est ce qui rend l'interconnexion cliquable dans les deux sens. Ils sont
 * tous à l'étage ouvert (le contrat le garantit), donc lisibles sans
 * session — un projet confidentiel ne peut pas être lié.
 */
export async function projectUsageOf(ctx: Ctx, repoId: number): Promise<readonly ProjectUsage[]> {
    return (await projectsProvider(ctx)?.usageOf('git', repoId, ctx.workspaceId)) ?? [];
}
