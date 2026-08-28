import {
    gitAuthorMap,
    gitBranchList,
    gitCommitDetail,
    gitCommitGraph,
    gitCommitList,
    gitPullRequestList,
    gitReleaseList
} from '../contracts/commands';
import { gitDiffStatusSchema, gitPullStateSchema, GIT_GRAPH_SHA_LEN } from '../contracts/domain';
import { defaultUserColor, USER_COLORS, type UserColor } from '@deveye/types';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { fetchCommitDetail } from './github';
import { loadHomeRepo, loadRepo, readJson, repoCipher, type Ctx, type StoredRepo } from './_shared';

/**
 * Lecture du cache alimenté par le service de fond.
 *
 * Tout ce qui s'affiche vient d'ici — l'ouverture d'un dépôt est donc
 * instantanée et ne consomme aucun quota. Une seule exception, délibérée : le
 * diff d'un commit (`gitCommitDetail`), lu chez le fournisseur à la demande.
 */

/** Teinte déterministe d'un auteur git non rattaché, dérivée de son empreinte. */
function colorForRef(ref: string): UserColor {
    let sum = 0;
    for (let i = 0; i < ref.length; i++) sum = (sum + ref.charCodeAt(i)) % 4096;
    return USER_COLORS[sum % USER_COLORS.length];
}

/**
 * Borne de sécurité, pas une limite de confort.
 *
 * Le graphe transporte **tout** l'historique : c'est ce qu'on lui demande, et la
 * forme colonnaire (voir `gitCommitPointsSchema`) le rend possible — cent mille
 * points pèsent ~2,3 Mo, là où autant d'objets JSON en pèseraient dix. Ce
 * plafond n'existe que pour qu'un dépôt monstrueux (un noyau, un miroir) ne
 * fasse pas exploser une trame WebSocket ; l'interface annonce alors combien de
 * points sont affichés plutôt que de laisser croire à un dépôt plus petit.
 */
const GRAPH_MAX_POINTS = 100_000;

export const gitReadFeatures = [
    defineSdkFeature({
        ...gitBranchList,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            // Le cache d'un dépôt projeté vit chez lui, sous sa clé.
            const cipher = await repoCipher(ctx, input.repoId);
            const rows = await ctx.repo.listBranches(input.repoId, repoRow.workspace_id);
            const base = rows.find((row) => row.is_default === 1);
            const branches = await Promise.all(
                rows.map(async (row) => {
                    // Les compteurs ne valent que pour le couple de sha qui les a
                    // produits. Dès qu'un des deux côtés a bougé, ils sont périmés :
                    // on rend `null` plutôt qu'un chiffre faux, et la
                    // synchronisation suivante les recalculera.
                    const fresh =
                        row.compared_sha !== null &&
                        base?.head_sha != null &&
                        row.head_sha != null &&
                        row.compared_sha === `${base.head_sha}..${row.head_sha}`;
                    return {
                        id: row.id,
                        name: (await readJson<{ name?: string }>(cipher, row.content))?.name ?? '',
                        headSha: row.head_sha,
                        isDefault: row.is_default === 1,
                        updatedAt: row.updated_at,
                        aheadCount: fresh ? (row.ahead_count ?? null) : null,
                        behindCount: fresh ? (row.behind_count ?? null) : null
                    };
                })
            );
            return { branches };
        }
    }),
    defineSdkFeature({
        ...gitCommitList,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            const cipher = await repoCipher(ctx, input.repoId);

            const limit = input.limit ?? 50;
            const rows = await ctx.repo.listCommits(
                input.repoId,
                repoRow.workspace_id,
                input.before ?? null,
                limit + 1
            );
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;

            const authors = new Map(
                (await ctx.repo.listAuthors(input.repoId, repoRow.workspace_id)).map((a) => [a.author_ref, a])
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
    }),
    defineSdkFeature({
        ...gitCommitGraph,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            const cipher = await repoCipher(ctx, input.repoId);

            // Les points ne coûtent aucun déchiffrement : ce sont trois colonnes
            // claires. C'est tout l'intérêt d'avoir gardé `committed_at` et
            // `author_ref` en clair.
            const [points, stats, counts, authorRows] = await Promise.all([
                ctx.repo.listCommitPoints(input.repoId, repoRow.workspace_id, GRAPH_MAX_POINTS),
                ctx.repo.commitStats(input.repoId, repoRow.workspace_id),
                ctx.repo.authorStats(input.repoId, repoRow.workspace_id),
                ctx.repo.listAuthors(input.repoId, repoRow.workspace_id)
            ]);

            const countByRef = new Map(counts.map((c) => [c.author_ref, c.commit_count]));
            // Un seul aller-retour pour les comptes rattachés, plutôt qu'un par
            // auteur : la liste des membres est courte, et c'est la façade
            // (`members.read`) qui la rend, couleur comprise. Demandée seulement
            // si un auteur est rattaché : sans rattachement, rien à colorier
            // par un compte.
            const linked = authorRows.some((a) => a.user_id !== null);
            const members = new Map((linked ? await ctx.deveye.members.list() : []).map((m) => [m.userId, m.color]));

            const authors = await Promise.all(
                authorRows.map(async (row) => {
                    const body = await readJson<{ name?: string; email?: string }>(cipher, row.content);
                    // Un auteur rattaché prend la couleur de son compte — la même
                    // que sa présence en direct, pour qu'une personne n'ait qu'une
                    // seule couleur dans toute l'application. La façade rend
                    // `null` sur un compte jamais colorié : on retombe alors sur
                    // la couleur dérivée de son identifiant, comme partout ailleurs.
                    const stored = row.user_id !== null ? members.get(row.user_id) : undefined;
                    const color =
                        row.user_id !== null ? (stored ?? defaultUserColor(row.user_id)) : colorForRef(row.author_ref);
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

            // Forme **colonnaire** : trois tableaux parallèles plutôt qu'un tableau
            // d'objets. À vingt mille commits, les accolades et les noms de champs
            // répétés dominaient la charge utile, et le client devait allouer autant
            // d'objets qu'il y avait de points. Voir `gitCommitPointsSchema`.
            //
            // Les sha sont concaténés en une seule chaîne de `GIT_GRAPH_SHA_LEN`
            // caractères par point : le graphe n'en fait que deux usages —
            // l'info-bulle, qui en montre sept, et l'ouverture d'un commit, que le
            // fournisseur accepte abrégée.
            const authorSlot = new Map(authors.map((a, i) => [a.authorRef, i]));
            const shas: string[] = [];
            const committedAt: number[] = [];
            const authorIndex: number[] = [];
            for (const p of points) {
                shas.push(p.sha.slice(0, GIT_GRAPH_SHA_LEN).padEnd(GIT_GRAPH_SHA_LEN, '0'));
                committedAt.push(p.committed_at);
                authorIndex.push(authorSlot.get(p.author_ref) ?? 0);
            }

            return {
                points: { count: points.length, shas: shas.join(''), committedAt, authorIndex },
                authors,
                firstCommitAt: stats.firstAt,
                lastCommitAt: stats.lastAt,
                total: stats.total
            };
        }
    }),
    defineSdkFeature({
        ...gitAuthorMap,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Domicile seulement : le rattachement lie un auteur aux MEMBRES de
            // l'espace du dépôt, que la fenêtre ne connaît pas.
            await loadHomeRepo(ctx, input.repoId);
            // L'appartenance par la façade (`members.read`, propriétaire
            // compris) : l'ex `workspaceMembers.isMember`, sans lire la table.
            if (input.userId !== null) {
                const members = await ctx.deveye.members.list();
                if (!members.some((m) => m.userId === input.userId)) {
                    throw new FeatureError('validation', 'Cette personne n’est pas membre de cet espace.');
                }
            }
            const ok = await ctx.repo.setAuthorUser(input.repoId, ctx.workspaceId, input.authorRef, input.userId);
            if (!ok) throw new FeatureError('not_found', 'Auteur introuvable');
            return { authorRef: input.authorRef, userId: input.userId };
        }
    }),
    defineSdkFeature({
        ...gitReleaseList,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            const cipher = await repoCipher(ctx, input.repoId);
            const rows = await ctx.repo.listReleases(input.repoId, repoRow.workspace_id);
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
    }),
    defineSdkFeature({
        ...gitPullRequestList,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            const cipher = await repoCipher(ctx, input.repoId);
            const rows = await ctx.repo.listPullRequests(input.repoId, repoRow.workspace_id);
            const pullRequests = await Promise.all(
                rows.map(async (row) => {
                    const body = await readJson<{
                        title?: string;
                        body?: string;
                        authorName?: string;
                        headBranch?: string;
                        baseBranch?: string;
                        url?: string;
                    }>(cipher, row.content);
                    return {
                        id: row.id,
                        number: row.number,
                        // `.catch()` du schéma : un état inconnu venu d'une autre
                        // version dégrade l'affichage, il ne casse pas la liste.
                        state: gitPullStateSchema.catch('open').parse(row.state),
                        title: body?.title ?? '',
                        body: body?.body ?? '',
                        authorName: body?.authorName ?? '',
                        headBranch: body?.headBranch ?? '',
                        baseBranch: body?.baseBranch ?? '',
                        url: body?.url || null,
                        createdAt: Number(row.created_at),
                        updatedAt: Number(row.updated_at),
                        mergedAt: row.merged_at === null ? null : Number(row.merged_at),
                        closedAt: row.closed_at === null ? null : Number(row.closed_at)
                    };
                })
            );
            return { pullRequests };
        }
    }),
    /**
     * Le diff d'un commit, lu chez le fournisseur **au moment de la demande**.
     *
     * C'est la seule lecture du module qui sorte du cache local, et donc la seule
     * dont la latence dépend d'une API tierce. Le parti pris est assumé : un diff
     * pèse des ordres de grandeur de plus que la ligne qui le résume, on ne le
     * regarde qu'une fois, et le conserver chiffré ferait grossir la base sans
     * contrepartie.
     */
    defineSdkFeature({
        ...gitCommitDetail,
        handler: async (ctx: Ctx, input) => {
            const repoRow = await loadRepo(ctx, input.repoId);
            if (repoRow.credential_id === null) {
                throw new FeatureError('validation', 'Le jeton d’accès a été retiré : le dépôt n’est plus lisible.');
            }

            const cipher = await repoCipher(ctx, input.repoId);
            const target = await readJson<Partial<StoredRepo>>(cipher, repoRow.content);
            if (!target?.owner || !target.repo) throw new FeatureError('internal', 'Dépôt illisible');

            // Le jeton du **domicile** du dépôt, scellé sous sa clé : il vit
            // dans l'espace du dépôt, et le chercher ici répondrait
            // « introuvable » sur un dépôt projeté parfaitement configuré.
            const credential = await ctx.repo.findCredential(repoRow.credential_id, repoRow.workspace_id);
            if (!credential) throw new FeatureError('not_found', 'Jeton introuvable');
            const token = await cipher.decrypt(credential.secret_enc);

            const detail = await fetchCommitDetail(target.owner, target.repo, token, input.sha);
            return {
                detail: {
                    sha: detail.sha,
                    message: detail.message,
                    authorName: detail.authorName,
                    committedAt: detail.committedAt,
                    url: detail.url || null,
                    additions: detail.additions,
                    deletions: detail.deletions,
                    files: detail.files.map((f) => ({
                        filename: f.filename,
                        previousFilename: f.previousFilename,
                        // `.catch()` : un état de fichier inconnu retombe sur
                        // « modifié » plutôt que de faire échouer tout le diff.
                        status: gitDiffStatusSchema.parse(f.status),
                        additions: f.additions,
                        deletions: f.deletions,
                        patch: f.patch
                    })),
                    truncated: detail.truncated
                }
            };
        }
    })
];
