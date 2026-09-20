import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
    GitBranchRow,
    GitCommitAuthorRow,
    GitCommitRow,
    GitCredentialRow,
    GitPullRequestRow,
    GitReleaseRow,
    GitRepoRow
} from '../contracts/domain';
import {
    GIT_ITEMS_PROVIDER,
    PROJECTS_USAGE_PROVIDER,
    type GitItemsProvider,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import {
    GitHubError,
    nameRef,
    type CommitPage,
    type GitHubBranch,
    type GitHubCommit,
    type GitHubPullRequest,
    type GitHubRelease,
    type GitHubSyncState
} from './github';
import { serverEntry } from './index';
import type { GitRepo } from './repo';
import { GitSync } from './service';

/**
 * La synchronisation de fond, sans réseau : l'adaptateur GitHub est injecté et
 * le test décide des réponses. Ce qui se vérifie ici ne lève nulle part
 * ailleurs : les branches suivent le distant, la tête est sautée au premier
 * tour, le rattrapage enchaîne ses tranches et son avancement survit entre
 * deux, seule la dernière release stable est dite à Projets, un 304 ne ravive
 * personne, un quota épuisé recule la prochaine tentative sans toucher à
 * l'état, et `syncStatus` / `runningIn` disent la vérité pendant et après.
 */

interface FakeRepo extends GitRepo {
    repos: GitRepoRow[];
    credentials: GitCredentialRow[];
    branches: GitBranchRow[];
    commits: GitCommitRow[];
    authors: GitCommitAuthorRow[];
    releases: GitReleaseRow[];
    pulls: GitPullRequestRow[];
}

const NOW = () => Math.floor(Date.now() / 1000);

function repo(over: Partial<GitRepoRow> = {}): GitRepoRow {
    return {
        id: 1,
        workspace_id: 1,
        credential_id: 10,
        provider: 'github',
        slug_ref: 'abc',
        enabled: 1,
        default_branch: null,
        last_sync_at: null,
        last_sync_error: null,
        sync_state: null,
        sort_order: 0,
        content: JSON.stringify({ owner: 'gerem66', repo: 'DevEye' }),
        created: 1,
        ...over
    };
}

function credential(over: Partial<GitCredentialRow> = {}): GitCredentialRow {
    return { id: 10, workspace_id: 1, label: 'Perso', secret_enc: 'ghp-secret', created: 1, ...over };
}

function commit(sha: string, committedAt: number, over: Partial<GitHubCommit> = {}): GitHubCommit {
    return {
        sha,
        message: `commit ${sha}`,
        authorName: 'Gerem',
        authorEmail: 'gerem@example.com',
        committedAt,
        parents: [],
        url: `https://github.com/gerem66/DevEye/commit/${sha}`,
        ...over
    };
}

function release(tag: string, publishedAt: number, isPrerelease = false): GitHubRelease {
    return {
        tag,
        name: tag,
        body: '',
        url: `https://github.com/gerem66/DevEye/releases/${tag}`,
        publishedAt,
        isPrerelease
    };
}

/** Un dépôt en mémoire ; le harnais chiffre à l'identité, donc les blobs sont le JSON en clair. */
function fakeRepo(repos: GitRepoRow[], credentials: GitCredentialRow[]): FakeRepo {
    let seq = 100;
    const branches: GitBranchRow[] = [];
    const commits: GitCommitRow[] = [];
    const authors: GitCommitAuthorRow[] = [];
    const releases: GitReleaseRow[] = [];
    const pulls: GitPullRequestRow[] = [];
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        repos,
        credentials,
        branches,
        commits,
        authors,
        releases,
        pulls,
        countReposInWorkspaces: async (ids: readonly number[]) =>
            repos.filter((r) => ids.includes(r.workspace_id)).length,
        listRepos: unused,
        listVisibleRepos: unused,
        findRepo: async (id, workspaceId) => repos.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
        // Sans projection dans ce faux : visible = chez lui.
        findVisibleRepo: async (id, workspaceId) =>
            repos.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
        findRepoBySlug: unused,
        countRepos: unused,
        createRepo: unused,
        updateRepo: unused,
        deleteRepo: unused,
        reorderRepos: unused,
        listCredentials: unused,
        findCredential: async (id, workspaceId) =>
            credentials.find((c) => c.id === id && c.workspace_id === workspaceId) ?? null,
        createCredential: unused,
        updateCredential: unused,
        removeCredential: unused,
        countCredentialUses: unused,
        // La requête du vrai dépôt, en mémoire : jamais synchronisé d'abord,
        // puis le plus ancien ; un dépôt sans jeton ou suspendu n'est pas tenté.
        listDue: async (limit) =>
            repos
                .filter((r) => r.enabled === 1 && r.credential_id !== null)
                .sort((a, b) => (a.last_sync_at ?? -1) - (b.last_sync_at ?? -1))
                .slice(0, limit),
        markSynced: async (repoId, input) => {
            const r = repos.find((x) => x.id === repoId);
            if (!r) return;
            r.last_sync_at = input.at;
            r.last_sync_error = input.error;
            r.sync_state = input.syncState;
            if (input.defaultBranch !== undefined) r.default_branch = input.defaultBranch;
        },
        resetCache: unused,
        async upsertBranch(input) {
            const b = branches.find((x) => x.repo_id === input.repoId && x.name_ref === input.nameRef);
            if (b) {
                b.head_sha = input.headSha;
                b.is_default = input.isDefault ? 1 : 0;
                b.updated_at = input.updatedAt;
                b.content = input.content;
                return;
            }
            branches.push({
                id: ++seq,
                repo_id: input.repoId,
                workspace_id: input.workspaceId,
                name_ref: input.nameRef,
                head_sha: input.headSha,
                ahead_count: null,
                behind_count: null,
                compared_sha: null,
                is_default: input.isDefault ? 1 : 0,
                updated_at: input.updatedAt,
                content: input.content
            });
        },
        async pruneBranches(repoId, keepRefs) {
            for (let i = branches.length - 1; i >= 0; i--) {
                if (branches[i].repo_id === repoId && !keepRefs.includes(branches[i].name_ref)) branches.splice(i, 1);
            }
        },
        listBranches: async (repoId, workspaceId) =>
            branches
                .filter((b) => b.repo_id === repoId && b.workspace_id === workspaceId)
                .sort((a, b) => b.is_default - a.is_default || a.id - b.id),
        async setBranchComparison(repoId, ref, input) {
            const b = branches.find((x) => x.repo_id === repoId && x.name_ref === ref);
            if (!b) return;
            b.ahead_count = input.ahead;
            b.behind_count = input.behind;
            b.compared_sha = input.comparedSha;
        },
        async upsertPullRequest(input) {
            const p = pulls.find((x) => x.repo_id === input.repoId && x.number === input.number);
            if (p) {
                Object.assign(p, {
                    state: input.state,
                    author_ref: input.authorRef,
                    updated_at: input.updatedAt,
                    merged_at: input.mergedAt,
                    closed_at: input.closedAt,
                    content: input.content
                });
                return;
            }
            pulls.push({
                id: ++seq,
                repo_id: input.repoId,
                workspace_id: input.workspaceId,
                number: input.number,
                state: input.state,
                author_ref: input.authorRef,
                created_at: input.createdAt,
                updated_at: input.updatedAt,
                merged_at: input.mergedAt,
                closed_at: input.closedAt,
                content: input.content
            });
        },
        listPullRequests: unused,
        async upsertAuthor(input) {
            const a = authors.find((x) => x.repo_id === input.repoId && x.author_ref === input.authorRef);
            if (a) {
                a.content = input.content;
                return;
            }
            authors.push({
                id: ++seq,
                repo_id: input.repoId,
                author_ref: input.authorRef,
                workspace_id: input.workspaceId,
                user_id: null,
                content: input.content,
                created: 1
            });
        },
        listAuthors: unused,
        setAuthorUser: unused,
        async insertCommit(input) {
            // `INSERT IGNORE` : relire un commit connu n'est pas une erreur.
            if (commits.some((c) => c.repo_id === input.repoId && c.sha === input.sha)) return;
            commits.push({
                id: ++seq,
                repo_id: input.repoId,
                workspace_id: input.workspaceId,
                sha: input.sha,
                committed_at: input.committedAt,
                author_ref: input.authorRef,
                parents: JSON.stringify(input.parents),
                content: input.content
            });
        },
        listCommits: unused,
        listCommitPoints: unused,
        commitStats: unused,
        authorStats: unused,
        latestCommitAt: async (repoId) => {
            const mine = commits.filter((c) => c.repo_id === repoId);
            return mine.length === 0 ? null : Math.max(...mine.map((c) => c.committed_at));
        },
        hasCommit: async (repoId, sha) => commits.some((c) => c.repo_id === repoId && c.sha === sha),
        async upsertRelease(input) {
            const r = releases.find((x) => x.repo_id === input.repoId && x.tag_ref === input.tagRef);
            if (r) {
                r.published_at = input.publishedAt;
                r.is_prerelease = input.isPrerelease ? 1 : 0;
                r.content = input.content;
                return;
            }
            releases.push({
                id: ++seq,
                repo_id: input.repoId,
                workspace_id: input.workspaceId,
                tag_ref: input.tagRef,
                published_at: input.publishedAt,
                is_prerelease: input.isPrerelease ? 1 : 0,
                content: input.content
            });
        },
        listReleases: async (repoId, workspaceId) =>
            releases
                .filter((r) => r.repo_id === repoId && r.workspace_id === workspaceId)
                .sort((a, b) => b.published_at - a.published_at || b.id - a.id)
    };
}

/** Ce que le dépôt distant factice répond. `null` sur une liste = 304, rien n'a changé. */
interface Remote {
    /** Absent = 304 sur le dépôt lui-même. */
    defaultBranch?: string;
    branches: GitHubBranch[] | null;
    /** Les commits d'une fenêtre : le test décide la tranche et si le distant est épuisé. */
    commits: (window: { ref?: string; since?: number; until?: number }) => CommitPage;
    comparison?: { ahead: number; behind: number };
    releases: GitHubRelease[] | null;
    pulls: GitHubPullRequest[] | null;
    /** Levée sur la première lecture : le tour entier échoue. */
    fail?: Error;
    /** Appelé à l'étape des releases : pour regarder l'avancement en plein tour. */
    onReleases?: () => void;
}

/** Le service sur le harnais, avec un GitHub piloté par le test. */
function syncWith(store: FakeRepo, remote: Remote) {
    const versions: [string, number, number, string][] = [];
    const projects: ProjectsUsageProvider = {
        usageOf: async () => [],
        countByItem: async () => new Map(),
        detach: async () => 0,
        recordEvent: async () => undefined,
        applyVersion: async (feature, itemId, workspaceId, version) => {
            versions.push([feature, itemId, workspaceId, version]);
        }
    };
    const deps = createTestServiceDeps({ repo: store, providers: { [PROJECTS_USAGE_PROVIDER]: projects } });
    const windows: { ref?: string; since?: number; until?: number }[] = [];
    const compared: [string, string][] = [];
    const sync = new GitSync(deps, {
        fetchRepoInfo: async (_o, _r, _t, etag) => {
            if (remote.fail) throw remote.fail;
            return remote.defaultBranch === undefined
                ? { data: null, etag: etag ?? null }
                : { data: { defaultBranch: remote.defaultBranch }, etag: 'W/"repo"' };
        },
        fetchBranches: async (_o, _r, _t, etag) =>
            remote.branches === null
                ? { data: null, etag: etag ?? null }
                : { data: remote.branches, etag: 'W/"branches"' },
        fetchCommits: async (_o, _r, _t, window) => {
            windows.push({ ...window });
            return remote.commits(window);
        },
        fetchComparison: async (_o, _r, _t, base, head) => {
            compared.push([base, head]);
            return remote.comparison ?? { ahead: 0, behind: 0 };
        },
        fetchReleases: async (_o, _r, _t, etag) => {
            remote.onReleases?.();
            return remote.releases === null
                ? { data: null, etag: etag ?? null }
                : { data: remote.releases, etag: 'W/"releases"' };
        },
        fetchPullRequests: async (_o, _r, _t, etag) =>
            remote.pulls === null ? { data: null, etag: etag ?? null } : { data: remote.pulls, etag: 'W/"pulls"' }
    });
    return { deps, sync, versions, windows, compared, tick: () => deps.recorded.tickers[0].tick() };
}

const stateOf = (row: GitRepoRow): GitHubSyncState => JSON.parse(row.sync_state ?? '{}') as GitHubSyncState;

/** Attend la fin d'un tour demandé hors cadence (`requestSync` ne rend rien). */
async function settled(sync: GitSync, repoId: number): Promise<void> {
    for (let i = 0; i < 200 && sync.syncStatus(repoId).running; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
const nameOf = (row: { content: string }): string => (JSON.parse(row.content) as { name: string }).name;

describe('un premier tour', () => {
    it('lit le dépôt, ses branches, une tranche d’historique, ses releases et ses PR, puis prévient l’espace', async () => {
        const store = fakeRepo([repo()], [credential()]);
        let seen: ReturnType<GitSync['syncStatus']> | null = null;
        let running: ReturnType<GitSync['runningIn']> = [];
        let elsewhere: ReturnType<GitSync['runningIn']> = [];
        const remote: Remote = {
            defaultBranch: 'main',
            branches: [
                { name: 'main', headSha: 'sha-m' },
                { name: 'feat', headSha: 'sha-f' }
            ],
            commits: (window) => {
                if (window.ref === 'feat') return { commits: [commit('sha-f', 150)], exhausted: true };
                return {
                    commits: [commit('sha-m', 200, { parents: ['sha-a'] }), commit('sha-a', 100)],
                    exhausted: true
                };
            },
            comparison: { ahead: 1, behind: 2 },
            releases: [release('v2.0.0-rc.1', 300, true), release('v1.0.0', 200)],
            pulls: [
                {
                    number: 3,
                    state: 'merged',
                    title: 'Une PR',
                    body: '',
                    authorLogin: 'gerem66',
                    headBranch: 'feat',
                    baseBranch: 'main',
                    url: '',
                    createdAt: 100,
                    updatedAt: 160,
                    mergedAt: 160,
                    closedAt: 160
                }
            ],
            onReleases: () => {
                seen = sync.syncStatus(1);
                running = sync.runningIn(1);
                elsewhere = sync.runningIn(2);
            }
        };
        const { deps, sync, versions, windows, compared, tick } = syncWith(store, remote);
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [120_000]
        );
        const before = NOW();
        await tick();

        // Les branches, la principale marquée ; les commits de la principale
        // (une seule fenêtre, sans « depuis » : la tête est sautée au premier
        // tour) puis ceux de la branche de travail, dont la tête était inconnue.
        assert.deepEqual(
            store.branches.map((b) => [
                nameOf(b),
                b.head_sha,
                b.is_default,
                b.ahead_count,
                b.behind_count,
                b.compared_sha
            ]),
            [
                ['main', 'sha-m', 1, null, null, null],
                ['feat', 'sha-f', 0, 1, 2, 'sha-m..sha-f']
            ]
        );
        assert.deepEqual(windows, [{}, { ref: 'feat' }]);
        assert.deepEqual(compared, [['main', 'feat']]);
        assert.deepEqual(
            store.commits.map((c) => [c.sha, c.committed_at]),
            [
                ['sha-m', 200],
                ['sha-a', 100],
                ['sha-f', 150]
            ]
        );
        assert.equal(store.authors.length, 1);

        // Les releases, et la dernière stable dite à Projets : la pré-version
        // ne fait pas la version d'un projet.
        assert.deepEqual(
            store.releases.map((r) => [r.tag_ref, r.is_prerelease]),
            [
                [nameRef('v2.0.0-rc.1'), 1],
                [nameRef('v1.0.0'), 0]
            ]
        );
        assert.deepEqual(versions, [['git', 1, 1, 'v1.0.0']]);
        assert.deepEqual(
            store.pulls.map((p) => [p.number, p.state, p.author_ref]),
            [[3, 'merged', nameRef('gerem66')]]
        );

        // Le tour est inscrit : l'historique est complet (le distant s'est
        // dit épuisé), les ETags sont retenus, la branche par défaut posée.
        const row = store.repos[0];
        assert.ok(row.last_sync_at !== null && row.last_sync_at >= before);
        assert.equal(row.last_sync_error, null);
        assert.equal(row.default_branch, 'main');
        assert.deepEqual(stateOf(row), {
            repoEtag: 'W/"repo"',
            branchesEtag: 'W/"branches"',
            backfillDone: true,
            releasesEtag: 'W/"releases"',
            pullsEtag: 'W/"pulls"'
        });
        assert.deepEqual(deps.recorded.liveChanges, [1]);

        // L'avancement, lu en plein tour puis après : à l'étape des releases,
        // visible depuis son espace seulement ; plus rien une fois fini.
        assert.deepEqual(seen, { running: true, phase: 'Releases', step: 4, stepCount: 6, startedAt: seen!.startedAt });
        assert.deepEqual(running, [{ repoId: 1, phase: 'Releases', step: 4, stepCount: 6 }]);
        assert.deepEqual(elsewhere, []);
        assert.deepEqual(sync.syncStatus(1), { running: false, phase: null, step: 0, stepCount: 6, startedAt: null });
        assert.deepEqual(sync.runningIn(1), []);
    });

    it('un dépôt sans jeton, ou suspendu, n’est pas tenté', async () => {
        const store = fakeRepo([repo({ credential_id: null }), repo({ id: 2, enabled: 0 })], [credential()]);
        const { deps, windows, tick } = syncWith(store, {
            branches: null,
            commits: () => ({ commits: [], exhausted: true }),
            releases: null,
            pulls: null
        });
        await tick();
        assert.deepEqual(windows, []);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });
});

describe('le backfill', () => {
    it('enchaîne les tranches jusqu’au premier commit, et l’avancement survit entre deux', async () => {
        const store = fakeRepo([repo()], [credential()]);
        const remote: Remote = {
            defaultBranch: 'main',
            branches: [{ name: 'main', headSha: 'sha-3' }],
            commits: (window) => {
                // La tête, en régime établi : rien de neuf.
                if (window.since !== undefined) return { commits: [], exhausted: true };
                // La queue : deux commits par tranche, puis le premier du dépôt.
                if (window.until === undefined) {
                    return { commits: [commit('sha-3', 300), commit('sha-2', 200)], exhausted: false };
                }
                return { commits: [commit('sha-2', 200), commit('sha-1', 100)], exhausted: true };
            },
            releases: null,
            pulls: null
        };
        const { sync, windows, tick } = syncWith(store, remote);

        await tick();
        // Une tranche lue, le distant n'est pas épuisé : la borne recule, et
        // l'entrée d'avancement survit, à l'étape des commits, pour que
        // l'interface ne conclue pas « terminé » pendant le répit.
        assert.deepEqual(windows, [{}]);
        assert.deepEqual(stateOf(store.repos[0]).backfillUntil, 200);
        assert.equal(stateOf(store.repos[0]).backfillDone, undefined);
        const between = sync.syncStatus(1);
        assert.deepEqual([between.running, between.phase, between.step], [true, 'Commits', 2]);

        // La tranche suivante (ici demandée à la main plutôt qu'attendue
        // trois secondes) : la tête depuis le plus récent connu, la queue
        // jusqu'à la borne, et le distant s'épuise. Le chronomètre affiché
        // n'est pas reparti de zéro.
        sync.requestSync(1);
        await settled(sync, 1);
        assert.deepEqual(windows.slice(1), [{ since: 300 }, { until: 200 }]);
        assert.deepEqual(
            store.commits.map((c) => c.sha),
            ['sha-3', 'sha-2', 'sha-1']
        );
        assert.equal(stateOf(store.repos[0]).backfillDone, true);
        assert.deepEqual(sync.syncStatus(1).running, false);
    });
});

describe('les tours suivants', () => {
    it('un tour de 304 ne ravive personne, mais s’inscrit', async () => {
        const store = fakeRepo(
            [
                repo({
                    default_branch: 'main',
                    last_sync_at: 1_000,
                    sync_state: JSON.stringify({ backfillDone: true, repoEtag: 'W/"repo"' })
                })
            ],
            [credential()]
        );
        store.branches.push({
            id: 1,
            repo_id: 1,
            workspace_id: 1,
            name_ref: nameRef('main'),
            head_sha: 'sha-m',
            ahead_count: null,
            behind_count: null,
            compared_sha: null,
            is_default: 1,
            updated_at: 1_000,
            content: JSON.stringify({ name: 'main' })
        });
        store.commits.push({
            id: 2,
            repo_id: 1,
            workspace_id: 1,
            sha: 'sha-m',
            committed_at: 900,
            author_ref: 'a',
            parents: '[]',
            content: '{}'
        });
        const { deps, windows, tick } = syncWith(store, {
            branches: null,
            commits: () => ({ commits: [], exhausted: true }),
            releases: null,
            pulls: null
        });
        const before = NOW();
        await tick();
        // Seule la tête a été demandée, depuis le plus récent connu ; rien
        // n'a bougé, personne n'est prévenu, l'ETag du dépôt est conservé.
        assert.deepEqual(windows, [{ since: 900 }]);
        assert.deepEqual(deps.recorded.liveChanges, []);
        assert.ok(store.repos[0].last_sync_at !== null && store.repos[0].last_sync_at >= before);
        assert.equal(stateOf(store.repos[0]).repoEtag, 'W/"repo"');
    });

    it('un quota épuisé inscrit un horodatage futur et l’erreur, sans toucher à l’état', async () => {
        const store = fakeRepo([repo({ sync_state: JSON.stringify({ backfillUntil: 500 }) })], [credential()]);
        const { deps, tick } = syncWith(store, {
            branches: null,
            commits: () => ({ commits: [], exhausted: true }),
            releases: null,
            pulls: null,
            fail: new GitHubError('Quota GitHub épuisé ; nouvelle tentative plus tard.', 403, true)
        });
        const before = NOW();
        await tick();
        const row = store.repos[0];
        // Une heure de recul : le seul moyen, avec un ordonnanceur qui trie par
        // ancienneté, de faire patienter ce dépôt sans bloquer les autres.
        assert.ok(row.last_sync_at !== null && row.last_sync_at >= before + 3600);
        assert.equal(row.last_sync_error, 'Quota GitHub épuisé ; nouvelle tentative plus tard.');
        assert.deepEqual(stateOf(row), { backfillUntil: 500 });
        assert.deepEqual(deps.recorded.liveChanges, []);
    });

    it('un autre échec s’inscrit à l’instant, et le tour suivant réessaie', async () => {
        const store = fakeRepo([repo()], [credential()]);
        const { tick } = syncWith(store, {
            branches: null,
            commits: () => ({ commits: [], exhausted: true }),
            releases: null,
            pulls: null,
            fail: new GitHubError('Jeton refusé par GitHub.', 401)
        });
        const before = NOW();
        await tick();
        const row = store.repos[0];
        assert.ok(row.last_sync_at !== null && row.last_sync_at >= before && row.last_sync_at < before + 60);
        assert.equal(row.last_sync_error, 'Jeton refusé par GitHub.');
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(store: FakeRepo): GitItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo: store }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[GIT_ITEMS_PROVIDER] as GitItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('GIT_ITEMS_PROVIDER : exists et labelOf', () => {
    it("rend le nom déchiffré d'un dépôt vivant, null pour un identifiant inconnu ou un espace qui ne le voit pas", async () => {
        const provider = itemsProviderOn(fakeRepo([repo()], [credential()]));
        assert.equal(await provider.exists(1, 1), true);
        assert.equal(await provider.exists(1, 2), false);
        assert.equal(await provider.labelOf(1, 1), 'gerem66/DevEye');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });

    it('un dépôt projeté vers un espace y existe, et se nomme sous le codec de son domicile', async () => {
        const store = fakeRepo([repo()], [credential()]);
        // La projection du dépôt 1 (chez 1) vers l'espace 2, telle que
        // `findVisibleRepo` la rend : la ligne du domicile, inchangée.
        store.findVisibleRepo = async (id, workspaceId) =>
            store.repos.find((r) => r.id === id && (r.workspace_id === workspaceId || workspaceId === 2)) ?? null;
        const provider = itemsProviderOn(store);
        assert.equal(await provider.exists(1, 2), true);
        assert.equal(await provider.labelOf(1, 2), 'gerem66/DevEye');
        assert.equal(await provider.exists(1, 3), false);
    });
});
