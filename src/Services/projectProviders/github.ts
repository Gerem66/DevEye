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

/** Les ETags mémorisés d'une synchronisation à l'autre. */
export interface GitHubSyncState {
    branchesEtag?: string;
    releasesEtag?: string;
    repoEtag?: string;
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
