import { createHash } from 'crypto';

/**
 * Adaptateur GitHub — lecture seule.
 *
 * Même parti pris que `Services/shortcutTemplates/` : `fetch` global, pas de
 * client HTTP maison, et une surface étroite qui rend le fournisseur
 * remplaçable. Tout ce qui suit ne fait que **lire** ; rien dans DevEye n'écrit
 * dans un dépôt.
 *
 * Deux économies structurantes :
 *
 *  - **ETags.** Chaque endpoint renvoie un `ETag` ; le renvoyer en
 *    `If-None-Match` vaut un 304, qui ne coûte **rien** au quota. C'est ce qui
 *    permet de synchroniser souvent sans épuiser les 5 000 requêtes/heure.
 *  - **`since`.** Les commits sont demandés à partir du dernier connu, jamais
 *    depuis l'origine des temps.
 */

const API = 'https://api.github.com';

/** Au-delà, on arrête de remonter : un premier import doit rester borné. */
const MAX_COMMIT_PAGES = 10;
const PER_PAGE = 100;

export class GitHubError extends Error {
    constructor(
        message: string,
        readonly status: number,
        /** L'échec vient du quota : le service de fond doit alors reculer. */
        readonly rateLimited = false
    ) {
        super(message);
        this.name = 'GitHubError';
    }
}

export interface GitHubCommit {
    sha: string;
    message: string;
    authorName: string;
    authorEmail: string;
    committedAt: number;
    parents: string[];
    url: string;
}

export interface GitHubBranch {
    name: string;
    headSha: string | null;
}

export interface GitHubRelease {
    tag: string;
    name: string;
    body: string;
    url: string;
    publishedAt: number;
    isPrerelease: boolean;
}

export interface GitHubRepoInfo {
    defaultBranch: string;
}

export interface GitHubPullRequest {
    number: number;
    state: 'open' | 'draft' | 'merged' | 'closed';
    title: string;
    body: string;
    authorLogin: string;
    headBranch: string;
    baseBranch: string;
    url: string;
    createdAt: number;
    updatedAt: number;
    mergedAt: number | null;
    closedAt: number | null;
}

/** Avance et retard d'une référence sur une autre. */
export interface GitHubComparison {
    ahead: number;
    behind: number;
}

export interface GitHubDiffFile {
    filename: string;
    previousFilename: string | null;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
}

export interface GitHubCommitDetail {
    sha: string;
    message: string;
    authorName: string;
    committedAt: number;
    url: string;
    additions: number;
    deletions: number;
    files: GitHubDiffFile[];
    /** GitHub écrête la liste des fichiers au-delà de 300. */
    truncated: boolean;
}

/** Les ETags mémorisés d'une synchronisation à l'autre. */
export interface GitHubSyncState {
    branchesEtag?: string;
    releasesEtag?: string;
    repoEtag?: string;
    pullsEtag?: string;
    /** Horodatage du commit le plus récent déjà connu, en secondes. */
    lastCommitAt?: number;
}

interface FetchResult<T> {
    /** `null` = 304, rien n'a changé depuis l'ETag fourni. */
    data: T | null;
    etag: string | null;
}

/**
 * Identité stable d'un auteur, **sans conserver son adresse en clair**.
 *
 * Le condensé sert de clé d'unicité et de graine de couleur ; l'adresse
 * lisible, elle, vit dans le payload chiffré.
 */
export function authorRef(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Condensé stable d'un nom (branche, tag) : porte l'unicité que le chiffré ne peut pas porter. */
export function nameRef(name: string): string {
    return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

async function call<T>(path: string, token: string, etag?: string): Promise<FetchResult<T>> {
    const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        'user-agent': 'DevEye'
    };
    if (etag) headers['if-none-match'] = etag;

    let res: Response;
    try {
        res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
        throw new GitHubError(e instanceof Error ? e.message : 'Dépôt injoignable', 0);
    }

    if (res.status === 304) return { data: null, etag: etag ?? null };

    if (!res.ok) {
        // Le quota se reconnaît à un 403/429 avec le compteur à zéro, jamais au
        // seul code : un 403 peut aussi être un dépôt privé sans droit.
        const remaining = res.headers.get('x-ratelimit-remaining');
        const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
        const message =
            res.status === 404
                ? 'Dépôt introuvable, ou jeton sans accès à ce dépôt.'
                : res.status === 401
                  ? 'Jeton refusé par GitHub.'
                  : rateLimited
                    ? 'Quota GitHub épuisé ; nouvelle tentative plus tard.'
                    : `GitHub a répondu ${res.status}.`;
        throw new GitHubError(message, res.status, rateLimited);
    }

    return { data: (await res.json()) as T, etag: res.headers.get('etag') };
}

interface RawCommit {
    sha: string;
    parents?: { sha: string }[];
    html_url?: string;
    commit?: {
        message?: string;
        author?: { name?: string; email?: string; date?: string };
    };
}

export async function fetchRepoInfo(
    owner: string,
    repo: string,
    token: string,
    etag?: string
): Promise<FetchResult<GitHubRepoInfo>> {
    const res = await call<{ default_branch?: string }>(`/repos/${owner}/${repo}`, token, etag);
    if (res.data === null) return { data: null, etag: res.etag };
    return { data: { defaultBranch: res.data.default_branch ?? 'main' }, etag: res.etag };
}

export async function fetchBranches(
    owner: string,
    repo: string,
    token: string,
    etag?: string
): Promise<FetchResult<GitHubBranch[]>> {
    const res = await call<{ name: string; commit?: { sha?: string } }[]>(
        `/repos/${owner}/${repo}/branches?per_page=${PER_PAGE}`,
        token,
        etag
    );
    if (res.data === null) return { data: null, etag: res.etag };
    return {
        data: res.data.map((b) => ({ name: b.name, headSha: b.commit?.sha ?? null })),
        etag: res.etag
    };
}

export async function fetchReleases(
    owner: string,
    repo: string,
    token: string,
    etag?: string
): Promise<FetchResult<GitHubRelease[]>> {
    const res = await call<
        {
            tag_name: string;
            name?: string | null;
            body?: string | null;
            html_url?: string;
            published_at?: string | null;
            prerelease?: boolean;
        }[]
    >(`/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}`, token, etag);
    if (res.data === null) return { data: null, etag: res.etag };
    return {
        data: res.data.map((r) => ({
            tag: r.tag_name,
            name: r.name ?? r.tag_name,
            body: r.body ?? '',
            url: r.html_url ?? '',
            publishedAt: r.published_at ? Math.floor(new Date(r.published_at).getTime() / 1000) : 0,
            isPrerelease: r.prerelease === true
        })),
        etag: res.etag
    };
}

/** Secondes unix, ou `null` — jamais `0`, qui se lirait comme 1970. */
function seconds(value: string | null | undefined): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

interface RawPull {
    number: number;
    state?: string;
    draft?: boolean;
    title?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string } | null;
    head?: { ref?: string } | null;
    base?: { ref?: string } | null;
    created_at?: string;
    updated_at?: string;
    merged_at?: string | null;
    closed_at?: string | null;
}

/**
 * Les pull requests, ouvertes comme fermées, les plus récemment actives d'abord.
 *
 * Une seule page : au-delà de cent, ce qui suit n'a plus été touché depuis
 * longtemps et n'apprend rien sur l'état courant du projet. Le fournisseur
 * confond « fusionnée » et « fermée » dans `state` ; on les sépare ici, sur la
 * seule preuve fiable — la présence de `merged_at`.
 */
export async function fetchPullRequests(
    owner: string,
    repo: string,
    token: string,
    etag?: string
): Promise<FetchResult<GitHubPullRequest[]>> {
    const res = await call<RawPull[]>(
        `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`,
        token,
        etag
    );
    if (res.data === null) return { data: null, etag: res.etag };
    return {
        data: res.data.map((raw) => {
            const mergedAt = seconds(raw.merged_at);
            const closedAt = seconds(raw.closed_at);
            const state: GitHubPullRequest['state'] =
                mergedAt !== null ? 'merged' : raw.state === 'closed' ? 'closed' : raw.draft ? 'draft' : 'open';
            const createdAt = seconds(raw.created_at) ?? 0;
            return {
                number: raw.number,
                state,
                title: raw.title ?? '',
                body: raw.body ?? '',
                authorLogin: raw.user?.login ?? '',
                headBranch: raw.head?.ref ?? '',
                baseBranch: raw.base?.ref ?? '',
                url: raw.html_url ?? '',
                createdAt,
                updatedAt: seconds(raw.updated_at) ?? createdAt,
                mergedAt,
                closedAt
            };
        }),
        etag: res.etag
    };
}

/**
 * De combien `head` est en avance et en retard sur `base`.
 *
 * Un appel par branche : c'est cher, et c'est la raison pour laquelle le
 * résultat est mémorisé avec le couple de sha qui l'a produit
 * (`project_branches.compared_sha`). Tant que ni la branche ni la base ne
 * bougent, la comparaison n'est pas refaite.
 */
export async function fetchComparison(
    owner: string,
    repo: string,
    token: string,
    base: string,
    head: string
): Promise<GitHubComparison> {
    const res = await call<{ ahead_by?: number; behind_by?: number }>(
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        token
    );
    return { ahead: res.data?.ahead_by ?? 0, behind: res.data?.behind_by ?? 0 };
}

/**
 * Le détail d'un commit, diff compris.
 *
 * Lu à la demande et jamais conservé — voir `projectCommitDetailSchema`. GitHub
 * n'inclut les `patch` que jusqu'à 300 fichiers et les omet pour les binaires
 * comme pour les fichiers trop volumineux ; l'absence est donc une information,
 * pas un défaut de lecture, et elle remonte telle quelle.
 */
export async function fetchCommitDetail(
    owner: string,
    repo: string,
    token: string,
    sha: string
): Promise<GitHubCommitDetail> {
    const res = await call<{
        sha?: string;
        html_url?: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
        stats?: { additions?: number; deletions?: number };
        files?: {
            filename?: string;
            previous_filename?: string;
            status?: string;
            additions?: number;
            deletions?: number;
            patch?: string;
        }[];
    }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`, token);

    const data = res.data ?? {};
    const files = data.files ?? [];
    return {
        sha: data.sha ?? sha,
        message: data.commit?.message ?? '',
        authorName: data.commit?.author?.name ?? '',
        committedAt: seconds(data.commit?.author?.date) ?? 0,
        url: data.html_url ?? '',
        additions: data.stats?.additions ?? 0,
        deletions: data.stats?.deletions ?? 0,
        files: files.map((f) => ({
            filename: f.filename ?? '',
            previousFilename: f.previous_filename ?? null,
            status: f.status ?? 'modified',
            additions: f.additions ?? 0,
            deletions: f.deletions ?? 0,
            patch: f.patch ?? null
        })),
        truncated: files.length >= 300
    };
}

/**
 * Les commits, du plus récent au plus ancien, à partir de `since`.
 *
 * Pagination bornée par {@link MAX_COMMIT_PAGES} : un premier import sur un
 * dépôt vieux de dix ans ne doit pas monopoliser l'ordonnanceur ni le quota.
 * Les tours suivants reprendront où celui-ci s'est arrêté.
 */
export async function fetchCommits(
    owner: string,
    repo: string,
    token: string,
    since?: number
): Promise<GitHubCommit[]> {
    const commits: GitHubCommit[] = [];
    const sinceParam = since ? `&since=${new Date(since * 1000).toISOString()}` : '';

    for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
        const res = await call<RawCommit[]>(
            `/repos/${owner}/${repo}/commits?per_page=${PER_PAGE}&page=${page}${sinceParam}`,
            token
        );
        const batch = res.data ?? [];
        for (const raw of batch) {
            const date = raw.commit?.author?.date;
            commits.push({
                sha: raw.sha,
                message: raw.commit?.message ?? '',
                authorName: raw.commit?.author?.name ?? '',
                authorEmail: raw.commit?.author?.email ?? '',
                committedAt: date ? Math.floor(new Date(date).getTime() / 1000) : 0,
                parents: (raw.parents ?? []).map((p) => p.sha),
                url: raw.html_url ?? ''
            });
        }
        // Une page incomplète est la dernière.
        if (batch.length < PER_PAGE) break;
    }
    return commits;
}
