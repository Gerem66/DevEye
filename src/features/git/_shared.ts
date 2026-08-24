import { createHash } from 'crypto';
import type { GitRepo, GitRepoRow } from '@deveye/types';
import { gitRepoSchema } from '@deveye/types';
import type { Cipher } from '@/Services/SecureStore';
import type { GitRepoWithUsageRow } from '@/db/repos/git';
import { FeatureError, type FeatureContext } from '../_define';
import { shareScope } from '../_sharing';

/**
 * Le socle de la feature Git.
 *
 * **Un seul chiffre, toujours l'étage ouvert.** C'est la différence la plus
 * importante avec le module Projets, qui choisit son chiffre par projet : un
 * dépôt appartient à l'espace et peut servir plusieurs projets de paliers
 * différents, il ne peut donc suivre aucun d'eux. Corollaire pratique : rien
 * ici ne demande jamais de mot de passe, et le service de fond lit tout sans
 * session — ce qui est précisément ce dont il a besoin.
 */
export function gitCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

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
export async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
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
 * Charge un dépôt de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `repoId` commence par là, sans quoi elle répondrait sur le dépôt d'autrui.
 */
export async function loadRepo(
    ctx: FeatureContext,
    repoId: number,
    level: 'read' | 'write' = 'read'
): Promise<GitRepoRow> {
    const row = await ctx.db.git.findVisibleRepo(repoId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
    // `assertItem` refuse en plus les dépôts qu'une restriction de rôle masque
    // ou passe en lecture seule.
    await ctx.assertItem('git', repoId, level);
    return row;
}

/**
 * Comme {@link loadRepo}, mais exige que le dépôt soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : ses réglages (son jeton se choisit
 * parmi les clés d'ici) et sa suppression. Une fenêtre lit et resynchronise.
 */
export async function loadHomeRepo(ctx: FeatureContext, repoId: number): Promise<GitRepoRow> {
    const row = await loadRepo(ctx, repoId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Ce dépôt appartient à un autre espace : il se règle et se supprime depuis là-bas.'
        );
    }
    return row;
}

/** Le codec du domicile d'un dépôt visible — celui d'ici pour un dépôt local. */
export async function repoCipher(ctx: FeatureContext, repoId: number): Promise<Cipher> {
    return (await shareScope(ctx, 'git')).cipherFor(repoId);
}

export async function toRepo(cipher: Cipher, row: GitRepoWithUsageRow, foreign: boolean): Promise<GitRepo> {
    const target = await readJson<Partial<StoredRepo>>(cipher, row.content);
    return gitRepoSchema.parse({
        foreign,
        id: row.id,
        provider: row.provider === 'dokploy' ? 'dokploy' : 'github',
        owner: target?.owner ?? '',
        repo: target?.repo ?? '',
        credentialId: row.credential_id,
        enabled: row.enabled === 1,
        defaultBranch: row.default_branch,
        lastSyncAt: row.last_sync_at,
        lastSyncError: row.last_sync_error ? await cipher.tryDecrypt(row.last_sync_error) : null,
        projectCount: row.project_count,
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
export async function reloadRepo(ctx: FeatureContext, repoId: number): Promise<GitRepo> {
    const row = await ctx.db.git.findVisibleRepoWithUsage(repoId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Dépôt introuvable');
    return toRepo(await repoCipher(ctx, row.id), row, row.workspace_id !== ctx.workspaceId);
}

export const READ = { feature: 'git' } as const;
export const WRITE = { feature: 'git', level: 'write' } as const;
