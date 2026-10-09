import { createHash } from 'crypto';

/**
 * Adaptateur GitHub, en lecture seule : `fetch` global, pas de client HTTP maison,
 * et une surface étroite qui rend le fournisseur remplaçable.
 *
 * Deux économies structurantes. Les ETags : renvoyer celui d'un endpoint en
 * `If-None-Match` vaut un 304, qui ne coûte rien au quota de 5 000 requêtes par
 * heure. Et `since` : les commits sont demandés à partir du dernier connu, jamais
 * depuis l'origine des temps.
 */

const API = 'https://api.github.com';

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
    /**
     * L'historique ancien a-t-il été entièrement rapatrié ? Sans ce drapeau, les
     * tours suivants repartiraient tous de `since = le plus récent connu` et rien
     * d'antérieur n'arriverait jamais ; on remonte le temps par tranches.
     */
    backfillDone?: boolean;
    /**
     * Jusqu'où le backfill de la branche par défaut est descendu. Mémorisé ici et
     * non déduit d'un `MIN(committed_at)` sur le cache, qui contient aussi les
     * autres branches : un seul commit ancien venu d'une branche latérale
     * abaisserait le minimum et ferait sauter tout l'historique intermédiaire.
     */
    backfillUntil?: number;
}

interface FetchResult<T> {
    /** `null` = 304, rien n'a changé depuis l'ETag fourni. */
    data: T | null;
    etag: string | null;
}

/**
 * Identité stable d'un auteur, sans conserver son adresse en clair : le condensé
 * sert de clé d'unicité et de graine de couleur, l'adresse lisible vit dans le
 * payload chiffré.
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
        /** Qui a **écrit** le code, et quand. C'est l'attribution. */
        author?: { name?: string; email?: string; date?: string };
        /** Quand le commit a **atterri** dans le dépôt. Voir `commitDate`. */
        committer?: { date?: string };
    };
}

/**
 * La date à retenir pour un commit : celle du committer, pas de l'auteur. C'est le
 * sens du champ (quand le travail a atterri dans le dépôt, qu'un rebase ou une PR
 * fusionnée écartent de la date d'écriture), et surtout celle sur laquelle GitHub
 * filtre `since` et `until` : borner le backfill sur la date d'auteur comparerait
 * deux grandeurs distinctes, et sauterait des commits en silence.
 *
 * L'auteur reste l'auteur : `authorName` / `authorEmail` viennent de `author`.
 */
function commitDate(raw: RawCommit): string | undefined {
    return raw.commit?.committer?.date ?? raw.commit?.author?.date;
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

/** Secondes unix, ou `null`, jamais `0`, qui se lirait comme 1970. */
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
 * Une seule page : au-delà de cent, ce qui suit n'a plus bougé depuis longtemps.
 * Le fournisseur confond « fusionnée » et « fermée » dans `state` ; on les sépare
 * sur la seule preuve fiable, la présence de `merged_at`.
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
 * De combien `head` est en avance et en retard sur `base`. Un appel par branche,
 * c'est cher : le résultat est mémorisé avec le couple de sha qui l'a produit
 * (`compared_sha`), et tant que ni la branche ni la base ne bougent, la
 * comparaison n'est pas refaite.
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
 * Le détail d'un commit, diff compris, lu à la demande et jamais conservé. GitHub
 * n'inclut les `patch` que jusqu'à 300 fichiers et les omet pour les binaires comme
 * pour les fichiers trop volumineux : l'absence est une information, pas un défaut
 * de lecture, et elle remonte telle quelle.
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
        commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } };
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
        // Même date que dans la liste (voir `commitDate`) : sinon un commit rebasé
        // afficherait une heure différente de celle du point cliqué dans le graphe.
        committedAt: seconds(data.commit?.committer?.date ?? data.commit?.author?.date) ?? 0,
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

/** Le résultat d'une lecture de commits, et si le distant en a encore. */
export interface CommitPage {
    commits: GitHubCommit[];
    /**
     * `true` quand le distant n'avait plus rien à rendre dans cette direction, et
     * non quand le budget de pages est épuisé : c'est ce qui dit au backfill s'il a
     * fini ou s'il doit reprendre au tour suivant.
     */
    exhausted: boolean;
}

/**
 * Lit des commits dans une fenêtre temporelle, avec un budget de pages. Trois
 * usages, un seul code :
 *
 *  - `{ since }` : la tête, ce qui est arrivé depuis le dernier commit connu.
 *  - `{ until }` : la queue, le backfill qui remonte le temps par tranches.
 *  - `{ ref }` : une branche précise. Sans lui, GitHub ne rend que la branche par
 *    défaut, et tout ce qui ne vit que sur une branche de travail reste invisible.
 *
 * `until` est inclusif chez GitHub : le commit de la borne revient à chaque
 * tranche, `INSERT IGNORE` le laisse tomber, mais c'est pourquoi l'appelant
 * surveille la progression de la borne et non le nombre de lignes insérées.
 */
export async function fetchCommits(
    owner: string,
    repo: string,
    token: string,
    window: { ref?: string; since?: number; until?: number },
    maxPages: number
): Promise<CommitPage> {
    const commits: GitHubCommit[] = [];
    const iso = (t: number) => new Date(t * 1000).toISOString();
    // La seconde de battement sur `until` est nécessaire : nos horodatages sont
    // arrondis à la seconde alors que GitHub date à la milliseconde et compare
    // strictement. Sans ce +1, tout commit partageant la seconde de la borne serait
    // sauté définitivement, le backfill ne repassant jamais. Le prix est un
    // chevauchement d'une seconde par tranche, qu'`INSERT IGNORE` absorbe.
    const bounds =
        (window.ref ? `&sha=${encodeURIComponent(window.ref)}` : '') +
        (window.since ? `&since=${iso(window.since)}` : '') +
        (window.until ? `&until=${iso(window.until + 1)}` : '');

    let exhausted = false;
    for (let page = 1; page <= maxPages; page++) {
        const res = await call<RawCommit[]>(
            `/repos/${owner}/${repo}/commits?per_page=${PER_PAGE}&page=${page}${bounds}`,
            token
        );
        const batch = res.data ?? [];
        for (const raw of batch) {
            const date = commitDate(raw);
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
        // Une page incomplète est la dernière : le distant n'a plus rien.
        if (batch.length < PER_PAGE) {
            exhausted = true;
            break;
        }
    }
    return { commits, exhausted };
}

/** Un dépôt proposé au choix, tel qu'on le liste pour un propriétaire. */
export interface GitHubOwnerRepo {
    name: string;
    private: boolean;
    archived: boolean;
    description: string;
    /** Dernier push, pour trier les dépôts vivants en tête. */
    pushedAt: number | null;
}

interface RawOwnerRepo {
    name: string;
    private?: boolean;
    archived?: boolean;
    description?: string | null;
    pushed_at?: string | null;
}

/**
 * Une requête GitHub sans jeton obligatoire : le reste de l'adaptateur travaille
 * authentifié, mais la découverte doit fonctionner avant qu'aucun jeton n'existe.
 * Sans jeton, GitHub ne rend que le public et applique un quota bien plus serré
 * (60 par heure et par IP), ce que l'appelant annonce à l'écran.
 */
async function callPublic<T>(path: string, token: string | null): Promise<T> {
    const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'DevEye'
    };
    if (token) headers.authorization = `Bearer ${token}`;

    let res: Response;
    try {
        res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
        throw new GitHubError(e instanceof Error ? e.message : 'GitHub injoignable', 0);
    }

    if (!res.ok) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
        const message =
            res.status === 404
                ? 'Propriétaire ou organisation introuvable.'
                : res.status === 401
                  ? 'Jeton refusé par GitHub.'
                  : rateLimited
                    ? token
                        ? 'Quota GitHub épuisé pour ce jeton.'
                        : 'Quota GitHub anonyme épuisé : choisissez un jeton.'
                    : `GitHub a répondu ${res.status}.`;
        throw new GitHubError(message, res.status, rateLimited);
    }
    return (await res.json()) as T;
}

function toOwnerRepo(raw: RawOwnerRepo): GitHubOwnerRepo {
    return {
        name: raw.name,
        private: raw.private === true,
        archived: raw.archived === true,
        description: raw.description ?? '',
        pushedAt: raw.pushed_at ? Math.floor(new Date(raw.pushed_at).getTime() / 1000) : null
    };
}

/**
 * Les dépôts d'un propriétaire ou d'une organisation. Trois chemins, essayés dans
 * cet ordre, parce que GitHub n'expose pas la même chose selon qui demande :
 *
 *  1. `/user/repos` quand le jeton appartient au propriétaire demandé : le seul
 *     endpoint qui rende ses dépôts privés. `/users/{login}/repos` ne rend que le
 *     public, même avec le jeton de l'intéressé, d'où l'aller-retour sur `/user`.
 *  2. `/orgs/{owner}/repos` : une organisation, dont un jeton membre voit aussi
 *     les dépôts privés.
 *  3. `/users/{owner}/repos` : le repli public, qui marche sans jeton.
 *
 * Une seule page : cent dépôts suffisent à choisir dans une liste.
 */
export async function listOwnerRepos(owner: string, token: string | null): Promise<GitHubOwnerRepo[]> {
    const query = `sort=pushed&direction=desc&per_page=${PER_PAGE}`;

    if (token) {
        // Qui est ce jeton ? La réponse décide de l'endpoint, et elle seule
        // permet d'atteindre les dépôts privés d'un compte personnel.
        let login: string | null = null;
        try {
            login = (await callPublic<{ login?: string }>('/user', token)).login ?? null;
        } catch {
            // Un jeton à portée réduite peut refuser `/user` sans être invalide
            // pour autant : on retombe simplement sur les chemins publics.
        }
        if (login && login.toLowerCase() === owner.trim().toLowerCase()) {
            const rows = await callPublic<RawOwnerRepo[]>(`/user/repos?affiliation=owner&${query}`, token);
            return rows.map(toOwnerRepo);
        }
    }

    try {
        const rows = await callPublic<RawOwnerRepo[]>(`/orgs/${owner}/repos?${query}`, token);
        return rows.map(toOwnerRepo);
    } catch (e) {
        // 404 = ce n'est pas une organisation. Toute autre cause (quota, jeton
        // refusé) doit remonter telle quelle plutôt que d'être masquée par un
        // second échec.
        if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }

    const rows = await callPublic<RawOwnerRepo[]>(`/users/${owner}/repos?${query}`, token);
    return rows.map(toOwnerRepo);
}

/** Un compte que le jeton atteint : le sien, ou une organisation. */
export interface GitHubOwner {
    login: string;
    kind: 'self' | 'organization';
}

interface RawRepoOwner {
    owner?: { login?: string; type?: string };
}

/**
 * Les comptes dont un jeton peut lister les dépôts : le sien, puis ses
 * organisations. Deux sources pour les organisations, parce qu'un jeton à grain
 * fin ne voit souvent pas `/user/orgs` mais lit bien les dépôts qu'on lui a
 * ouverts : leurs propriétaires complètent la liste.
 *
 * Chaque appel peut échouer seul (portée réduite) ; seul l'échec de tous remonte.
 */
export async function listTokenOwners(token: string): Promise<GitHubOwner[]> {
    const [self, orgs, repos] = await Promise.allSettled([
        callPublic<{ login?: string }>('/user', token),
        callPublic<{ login?: string }[]>(`/user/orgs?per_page=${PER_PAGE}`, token),
        callPublic<RawRepoOwner[]>(
            `/user/repos?affiliation=owner,organization_member&sort=pushed&per_page=${PER_PAGE}`,
            token
        )
    ]);
    if (self.status === 'rejected' && orgs.status === 'rejected' && repos.status === 'rejected') throw self.reason;

    const login = self.status === 'fulfilled' ? (self.value.login ?? null) : null;
    const organizations = new Map<string, string>();
    const add = (name: string | undefined): void => {
        if (name && name.toLowerCase() !== login?.toLowerCase()) organizations.set(name.toLowerCase(), name);
    };
    if (orgs.status === 'fulfilled') for (const org of orgs.value) add(org.login);
    if (repos.status === 'fulfilled') {
        for (const repo of repos.value) if (repo.owner?.type === 'Organization') add(repo.owner.login);
    }

    return [
        ...(login ? [{ login, kind: 'self' as const }] : []),
        ...[...organizations.values()]
            .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }))
            .map((name) => ({ login: name, kind: 'organization' as const }))
    ];
}

/** Un workflow ou un déploiement GitHub, réduit à ce qui dit si le code est en ligne. */
export interface GitHubDeployEvent {
    state: 'success' | 'running';
    /** La fin d'un succès, le départ d'un « en cours », en secondes. */
    at: number;
    /** Ce qu'un journal en dit : `le workflow « Deploy »`, `le déploiement GitHub « production »`. */
    what: string;
}

const RUNNING_RUN = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const RUNNING_DEPLOYMENT = new Set(['queued', 'in_progress', 'pending']);

interface RawRun {
    name?: string;
    status?: string;
    conclusion?: string | null;
    run_started_at?: string;
    created_at?: string;
    updated_at?: string;
}

/**
 * Les exécutions récentes des workflows d'une branche : les réussies, datées
 * de leur fin, et celles encore en cours. Un échec n'a rien mis en ligne et
 * n'est pas rendu. Demande au jeton le droit Actions en lecture.
 */
export async function fetchWorkflowRuns(
    owner: string,
    repo: string,
    token: string | null,
    branch: string
): Promise<GitHubDeployEvent[]> {
    const res = await callPublic<{ workflow_runs?: RawRun[] }>(
        `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
        token
    );
    const now = Math.floor(Date.now() / 1000);
    const events: GitHubDeployEvent[] = [];
    for (const run of res.workflow_runs ?? []) {
        const what = `le workflow « ${run.name ?? 'sans nom'} »`;
        const ended = seconds(run.updated_at);
        if (run.status === 'completed' && run.conclusion === 'success' && ended !== null) {
            events.push({ state: 'success', at: ended, what });
        } else if (run.status && RUNNING_RUN.has(run.status)) {
            events.push({ state: 'running', at: seconds(run.run_started_at ?? run.created_at) ?? now, what });
        }
    }
    return events;
}

interface RawDeployment {
    id: number;
    environment?: string;
    transient_environment?: boolean;
    created_at?: string;
}

/** Au-delà, un déploiement créé avant le début de la fenêtre ne s'y termine plus. */
const DEPLOYMENT_LOOKBACK_SECONDS = 2 * 3600;
const DEPLOYMENTS_READ = 5;

/**
 * Les déploiements GitHub récents (ce que publient GitHub Pages, Vercel,
 * Netlify ou un workflow à `environment`) : réussis, datés de leur statut
 * `success`, ou encore en cours. Un environnement transitoire (l'aperçu d'une
 * PR) ne met rien en production et n'est pas rendu. Demande au jeton le droit
 * Deployments en lecture.
 */
export async function fetchDeployments(
    owner: string,
    repo: string,
    token: string | null,
    since: number
): Promise<GitHubDeployEvent[]> {
    const deployments = await callPublic<RawDeployment[]>(`/repos/${owner}/${repo}/deployments?per_page=10`, token);
    const recent = deployments
        .filter((d) => !d.transient_environment && (seconds(d.created_at) ?? 0) >= since - DEPLOYMENT_LOOKBACK_SECONDS)
        .slice(0, DEPLOYMENTS_READ);
    const events: GitHubDeployEvent[] = [];
    await Promise.all(
        recent.map(async (deployment) => {
            const statuses = await callPublic<{ state?: string; created_at?: string }[]>(
                `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=10`,
                token
            );
            const what = `le déploiement GitHub « ${deployment.environment ?? 'sans nom'} »`;
            const succeededAt = seconds(statuses.find((s) => s.state === 'success')?.created_at);
            const latest = statuses[0];
            if (succeededAt !== null) events.push({ state: 'success', at: succeededAt, what });
            else if (!latest || (latest.state && RUNNING_DEPLOYMENT.has(latest.state))) {
                const started = seconds(latest?.created_at ?? deployment.created_at);
                events.push({ state: 'running', at: started ?? Math.floor(Date.now() / 1000), what });
            }
        })
    );
    return events;
}
