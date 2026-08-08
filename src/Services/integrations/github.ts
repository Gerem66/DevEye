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
     * L'historique ancien a-t-il été entièrement rapatrié ?
     *
     * Sans ce drapeau, un dépôt n'aurait jamais que ses commits récents : le
     * premier tour en lisait mille, et tous les suivants repartaient de
     * `since = le plus récent connu`, si bien que **rien d'antérieur ne pouvait
     * plus jamais arriver**. C'est ce que cette bascule répare — on remonte le
     * temps par tranches jusqu'à toucher le premier commit du dépôt.
     */
    backfillDone?: boolean;
    /**
     * Jusqu'où le backfill de la **branche par défaut** est descendu.
     *
     * Mémorisé ici plutôt que déduit d'un `MIN(committed_at)` sur le cache, et
     * c'est une correction de fond : le cache contient aussi les commits des
     * autres branches. Un seul commit ancien venu d'une branche latérale
     * abaissait le minimum global, la tranche suivante repartait de bien plus
     * bas, et **tout l'historique intermédiaire de la branche principale était
     * sauté** — sans que rien ne le signale.
     */
    backfillUntil?: number;
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
        /** Qui a **écrit** le code, et quand. C'est l'attribution. */
        author?: { name?: string; email?: string; date?: string };
        /** Quand le commit a **atterri** dans le dépôt. Voir `commitDate`. */
        committer?: { date?: string };
    };
}

/**
 * La date à retenir pour un commit : celle du **committer**, pas de l'auteur.
 *
 * Deux raisons, et la seconde est un piège coûteux :
 *
 *  1. C'est le sens du champ. `committed_at` répond à « quand ce travail
 *     a-t-il atterri dans le dépôt ? » ; la date d'auteur répond à « quand a-t-il
 *     été écrit ? ». Un rebase, un cherry-pick ou une PR fusionnée des semaines
 *     plus tard écartent les deux.
 *  2. **C'est celle sur laquelle GitHub filtre** ses paramètres `since` et
 *     `until`. Mesuré sur un dépôt ordinaire : 66 commits sur 100 ont deux dates
 *     différentes. Borner le backfill sur la date d'auteur revenait donc à
 *     comparer deux grandeurs distinctes — la borne pouvait ne pas reculer, ou
 *     sauter des commits sans que rien ne le signale.
 *
 * L'auteur reste l'auteur : `authorName` / `authorEmail` continuent de venir de
 * `author`, et c'est bien lui qui colore le graphe.
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
        // Même date que dans la liste (voir `commitDate`) : sans ça, la popup
        // d'un commit rebasé afficherait une heure différente de celle du point
        // qu'on vient de cliquer dans le graphe.
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
     * `true` quand le distant n'avait plus rien à rendre dans cette direction —
     * et non quand on a simplement épuisé son budget de pages. C'est cette
     * distinction qui dit au backfill s'il a fini ou s'il doit reprendre au tour
     * suivant.
     */
    exhausted: boolean;
}

/**
 * Lit des commits dans une fenêtre temporelle, avec un budget de pages.
 *
 * Trois usages, un seul code :
 *
 *  - `{ since }` — la **tête** : ce qui est arrivé depuis le dernier commit
 *    connu. Court en régime établi, souvent vide.
 *  - `{ until }` — la **queue** : on remonte le temps depuis le plus ancien
 *    commit connu. C'est le backfill, qui converge en quelques tours.
 *  - `{ ref }` — une **branche** précise. ⚠️ Sans lui, GitHub ne rend que la
 *    branche **par défaut** : tout ce qui ne vit que sur une branche de travail
 *    reste invisible. C'est ce paramètre qui fait que « tous les commits » veut
 *    vraiment dire tous.
 *
 * `until` est inclusif chez GitHub : le commit de la borne revient à chaque
 * tranche. Sans conséquence — `INSERT IGNORE` le laisse tomber — mais c'est la
 * raison pour laquelle l'appelant surveille la **progression** de la borne et
 * non le simple nombre de lignes insérées.
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
    // ⚠️ La seconde de battement sur `until` n'est pas de la prudence gratuite.
    //
    // Nos horodatages sont **arrondis à la seconde** (`Math.floor`), alors que
    // GitHub date ses commits à la milliseconde et compare strictement. Une
    // borne posée à `12:00:07.000` exclut donc un commit réellement daté
    // `12:00:07.400` — mesuré : la tranche suivante ne renvoie pas le commit de
    // la borne. Sans ce +1, tout commit partageant la seconde de la borne serait
    // sauté **définitivement**, puisque le backfill ne repasse jamais.
    //
    // Le prix est un chevauchement d'une seconde par tranche, que
    // `INSERT IGNORE` absorbe sans bruit.
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
 * Une requête GitHub **sans jeton obligatoire**.
 *
 * Le reste de l'adaptateur travaille toujours authentifié : on synchronise un
 * dépôt qu'on a explicitement relié, avec le jeton qu'on lui a donné. La
 * découverte, elle, doit fonctionner avant qu'aucun jeton n'existe — c'est
 * précisément le moment où l'on en cherche un. Sans jeton, GitHub ne rend que
 * le public et applique un quota horaire bien plus serré (60 par IP), ce que
 * l'appelant annonce à l'écran plutôt que de le subir en silence.
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
                        : 'Quota GitHub anonyme épuisé — choisissez un jeton.'
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
 * Les dépôts d'un propriétaire ou d'une organisation.
 *
 * Trois chemins, essayés dans cet ordre, parce que GitHub n'expose pas la même
 * chose selon qui demande :
 *
 *  1. **`/user/repos`** quand le jeton appartient au propriétaire demandé —
 *     c'est le **seul** endpoint qui rende ses dépôts privés. `/users/{login}/repos`
 *     ne rend que le public, même avec le jeton de l'intéressé : c'est le piège
 *     de cette API, et la raison de l'aller-retour sur `/user`.
 *  2. **`/orgs/{owner}/repos`** — une organisation, dont un jeton membre voit
 *     aussi les dépôts privés.
 *  3. **`/users/{owner}/repos`** — le repli public, qui marche sans jeton.
 *
 * Une seule page : cent dépôts suffisent à choisir dans une liste, et
 * paginer pour en proposer trois cents serait rendre le choix plus difficile,
 * pas plus complet.
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
