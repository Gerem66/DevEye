import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    gitCount,
    gitCredentialAdd,
    gitCredentialList,
    gitCredentialRemove,
    gitCredentialUpdate,
    gitRepoAdd,
    gitRepoGet,
    gitRepoList,
    gitRepoRemove,
    gitRepoReorder,
    gitRepoResync,
    gitRepoSyncNow,
    gitRepoSyncStatus,
    gitRepoUpdate,
    gitSyncStatuses
} from '../contracts/commands';
import type { GitCredentialRow, GitRepoRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { gitHandlers } from './handlers';
import type { GitRepo } from './repo';
import type { GitSync } from './service';
import { setSync, slugRef } from './_shared';

/**
 * Ce qui se vérifie ici ne lève nulle part ailleurs : les restrictions par
 * élément (un dépôt masqué disparaît de la liste et du compte), le partage
 * inter-espaces (une projection se liste `foreign`, ne se règle ni ne se
 * supprime depuis la fenêtre), le contrat de Projets (absent, il vaut zéro
 * plutôt qu'une erreur), l'idempotence de l'ajout, le ménage à la suppression,
 * les jetons GitHub (secret jamais rendu, retrait qui met ses dépôts à NULL)
 * et l'absence de service de fond.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = gitHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<GitRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends GitRepo {
    repos: GitRepoRow[];
    credentials: GitCredentialRow[];
    /** Les dépôts dont le cache a été jeté, dans l'ordre. */
    reset: number[];
}

/** Un dépôt en base, tel que le vrai dépôt le rendrait (contenu en clair : le harnais chiffre à l'identité). */
function repo(over: Partial<GitRepoRow> & { id: number; workspace_id: number }): GitRepoRow {
    const owner = 'gerem66';
    const name = `depot-${over.id}`;
    return {
        credential_id: 10,
        provider: 'github',
        slug_ref: slugRef(owner, name),
        enabled: 1,
        default_branch: 'main',
        last_sync_at: null,
        last_sync_error: null,
        sync_state: null,
        sort_order: over.id,
        content: JSON.stringify({ owner, repo: name }),
        created: 1,
        ...over
    };
}

function credential(over: Partial<GitCredentialRow> & { id: number; workspace_id: number }): GitCredentialRow {
    return { label: `Jeton ${over.id}`, secret_enc: 'ghp-secret', created: 1, ...over };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai. `projections` reproduit
 * `item_shares` (dépôt → espaces où il est projeté) et doit correspondre au
 * `shares` du harnais, sinon `ctx.sharing.scope()` ignore le domicile.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const repos: GitRepoRow[] = [];
    const credentials: GitCredentialRow[] = [];
    const reset: number[] = [];
    const visible = (r: GitRepoRow, workspaceId: number) =>
        r.workspace_id === workspaceId || (projections[r.id] ?? []).includes(workspaceId);
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        repos,
        credentials,
        reset,
        listRepos: async (workspaceId) => repos.filter((r) => r.workspace_id === workspaceId),
        listVisibleRepos: async (workspaceId) => repos.filter((r) => visible(r, workspaceId)),
        // Des copies, comme des lignes lues en base : un handler compare ce
        // qu'il a chargé AVANT d'écrire à ce qu'il vient d'écrire.
        findRepo: async (id, workspaceId) => copyOf(repos.find((r) => r.id === id && r.workspace_id === workspaceId)),
        findVisibleRepo: async (id, workspaceId) => copyOf(repos.find((r) => r.id === id && visible(r, workspaceId))),
        findRepoBySlug: async (workspaceId, slug) =>
            repos.find((r) => r.workspace_id === workspaceId && r.slug_ref === slug) ?? null,
        countRepos: async (workspaceId) => repos.filter((r) => r.workspace_id === workspaceId).length,
        async createRepo(input) {
            const created = repo({
                id: ++seq,
                workspace_id: input.workspaceId,
                provider: input.provider,
                slug_ref: input.slugRef,
                credential_id: input.credentialId,
                content: input.content
            });
            repos.push(created);
            return created;
        },
        async updateRepo(id, workspaceId, input) {
            const r = repos.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (!r) return null;
            r.credential_id = input.credentialId;
            r.enabled = input.enabled ? 1 : 0;
            return r;
        },
        async deleteRepo(id, workspaceId) {
            const i = repos.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
            if (i === -1) return false;
            repos.splice(i, 1);
            return true;
        },
        async reorderRepos(workspaceId, ids) {
            ids.forEach((id, i) => {
                const r = repos.find((x) => x.id === id && x.workspace_id === workspaceId);
                if (r) r.sort_order = i;
            });
        },
        listCredentials: async (workspaceId) => credentials.filter((c) => c.workspace_id === workspaceId),
        findCredential: async (id, workspaceId) =>
            credentials.find((c) => c.id === id && c.workspace_id === workspaceId) ?? null,
        async createCredential(input) {
            const created = credential({
                id: ++seq,
                workspace_id: input.workspaceId,
                label: input.label,
                secret_enc: input.secretEnc
            });
            credentials.push(created);
            return created;
        },
        async updateCredential(id, workspaceId, input) {
            const c = credentials.find((x) => x.id === id && x.workspace_id === workspaceId);
            if (!c) return null;
            c.label = input.label;
            if (input.secretEnc !== undefined) c.secret_enc = input.secretEnc;
            return c;
        },
        async removeCredential(id, workspaceId) {
            // Le ménage du vrai dépôt : les dépôts du jeton passent à NULL
            // avant que la ligne ne parte.
            for (const r of repos) {
                if (r.credential_id === id && r.workspace_id === workspaceId) r.credential_id = null;
            }
            const i = credentials.findIndex((c) => c.id === id && c.workspace_id === workspaceId);
            if (i === -1) return false;
            credentials.splice(i, 1);
            return true;
        },
        countCredentialUses: async (workspaceId) => {
            const uses = new Map<number, number>();
            for (const r of repos) {
                if (r.workspace_id !== workspaceId || r.credential_id === null) continue;
                uses.set(r.credential_id, (uses.get(r.credential_id) ?? 0) + 1);
            }
            return uses;
        },
        markSynced: unused,
        listDue: unused,
        async resetCache(repoId, workspaceId) {
            const r = repos.find((x) => x.id === repoId && x.workspace_id === workspaceId);
            if (!r) return false;
            r.sync_state = null;
            r.last_sync_at = null;
            r.last_sync_error = null;
            reset.push(repoId);
            return true;
        },
        upsertBranch: unused,
        pruneBranches: unused,
        listBranches: unused,
        setBranchComparison: unused,
        upsertPullRequest: unused,
        listPullRequests: unused,
        upsertAuthor: unused,
        listAuthors: unused,
        setAuthorUser: unused,
        insertCommit: unused,
        listCommits: unused,
        listCommitPoints: unused,
        commitStats: unused,
        authorStats: unused,
        latestCommitAt: unused,
        hasCommit: unused,
        upsertRelease: unused,
        listReleases: unused
    };
}

const copyOf = (row: GitRepoRow | undefined): GitRepoRow | null => (row ? { ...row } : null);

function seed(store: FakeRepo, ...seeded: GitRepoRow[]): FakeRepo {
    store.repos.push(...seeded);
    return store;
}

/** Le contrat de Projets, tel que l'app (ou son module) l'offre : l'espace 1 relie le dépôt 1 à deux projets. */
function projectsProvider(): ProjectsUsageProvider {
    return {
        usageOf: async (feature, itemId, workspaceId) =>
            feature === 'git' && itemId === 1 && workspaceId === 1
                ? [
                      { projectId: 5, title: 'Boutique', status: 'active' },
                      { projectId: 6, title: 'Sans titre', status: 'draft' }
                  ]
                : [],
        countByItem: async (feature, workspaceId) =>
            feature === 'git' && workspaceId === 1 ? new Map([[1, 2]]) : new Map(),
        recordEvent: async () => undefined,
        applyVersion: async () => undefined
    };
}

/**
 * Le service de fond, factice : ce que les handlers lui demandent (un réveil,
 * l'avancement d'un dépôt, ceux d'un espace), posé par `setSync` comme
 * `createService` le fait au boot.
 */
function mountFakeSync() {
    const requested: number[] = [];
    const sync = {
        requestSync: (repoId: number) => {
            requested.push(repoId);
        },
        syncStatus: (repoId: number) => ({
            running: true,
            phase: 'Commits',
            step: 2,
            stepCount: 6,
            startedAt: 1_000 + repoId
        }),
        runningIn: (workspaceId: number) =>
            workspaceId === 1 ? [{ repoId: 1, phase: 'Commits', step: 2, stepCount: 6 }] : []
    };
    setSync(sync as unknown as GitSync);
    return requested;
}

afterEach(() => setSync(null));

describe('git.count et git.repoList', () => {
    it('retirent un dépôt masqué pour ce rôle et comptent les projets par le contrat', async () => {
        const store = seed(
            fakeRepo(),
            repo({ id: 1, workspace_id: 1 }),
            repo({ id: 2, workspace_id: 1, credential_id: null, last_sync_error: 'Le jeton d’accès a été retiré.' }),
            repo({ id: 3, workspace_id: 1 })
        );
        const ctx = createTestContext({
            repo: store,
            itemRestrictions: { 3: 'none' },
            providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() }
        });

        const listed = await handlerFor(gitRepoList)(ctx, {});
        assert.deepEqual(
            listed.repos.map((r) => [
                r.id,
                `${r.owner}/${r.repo}`,
                r.foreign,
                r.credentialId,
                r.lastSyncError,
                r.projectCount
            ]),
            [
                [1, 'gerem66/depot-1', false, 10, null, 2],
                [2, 'gerem66/depot-2', false, null, 'Le jeton d’accès a été retiré.', 0]
            ]
        );
        // La carte compte ce que la liste montre, restrictions déduites.
        assert.deepEqual(await handlerFor(gitCount)(ctx, {}), { count: 2 });
    });

    it('sans contrat de Projets, le compte vaut zéro plutôt qu’une erreur', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }));
        const listed = await handlerFor(gitRepoList)(createTestContext({ repo: store }), {});
        assert.equal(listed.repos[0].projectCount, 0);
        const got = await handlerFor(gitRepoGet)(createTestContext({ repo: store }), { repoId: 1 });
        assert.deepEqual([got.repo.projectCount, got.usage], [0, []]);
    });
});

describe('le partage inter-espaces', () => {
    it("liste une projection avec sa pastille `foreign`, sous le codec de son espace d'origine", async () => {
        // Le dépôt 7 vit dans l'espace 42 et se projette vers l'espace 1.
        const store = seed(fakeRepo({ 7: [1] }), repo({ id: 7, workspace_id: 42 }));
        const ctx = createTestContext({ repo: store, workspaceId: 1, shares: { 7: 42 } });

        // Le codec est demandé pour la ligne : le harnais rend l'identité,
        // l'appel est ce qui se vérifie.
        const asked: number[] = [];
        const scope = ctx.sharing.scope;
        ctx.sharing = {
            scope: async () => {
                const real = await scope();
                return {
                    ...real,
                    cipherFor: (itemId) => {
                        asked.push(itemId);
                        return real.cipherFor(itemId);
                    }
                };
            }
        };
        const listed = await handlerFor(gitRepoList)(ctx, {});
        assert.deepEqual(
            listed.repos.map((r) => [r.id, r.foreign]),
            [[7, true]]
        );
        assert.deepEqual(asked, [7]);
    });

    it('refuse de régler ou de supprimer une projection depuis la fenêtre, mais la resynchronise', async () => {
        const store = seed(fakeRepo({ 7: [1] }), repo({ id: 7, workspace_id: 42 }));
        store.credentials.push(credential({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store, workspaceId: 1, shares: { 7: 42 } });
        const requested = mountFakeSync();

        await assert.rejects(
            handlerFor(gitRepoUpdate)(ctx, { repoId: 7, credentialId: 10, enabled: false }),
            failsWith('forbidden')
        );
        assert.equal(store.repos[0].enabled, 1);
        await assert.rejects(handlerFor(gitRepoRemove)(ctx, { repoId: 7 }), failsWith('forbidden'));
        assert.equal(store.repos.length, 1);

        // Réveiller la synchronisation d'un dépôt projeté rafraîchit la même
        // donnée pour tout le monde, chez lui.
        const out = await handlerFor(gitRepoSyncNow)(ctx, { repoId: 7 });
        assert.equal(out.repo.foreign, true);
        assert.deepEqual(requested, [7]);
    });

    it('répond `not_found` pour un dépôt d’un autre espace non projeté', async () => {
        const store = seed(fakeRepo(), repo({ id: 7, workspace_id: 42 }));
        await assert.rejects(
            handlerFor(gitRepoGet)(createTestContext({ repo: store, workspaceId: 1 }), { repoId: 7 }),
            failsWith('not_found')
        );
    });
});

describe('git.repoGet', () => {
    it('rend le dépôt et les projets qui s’en servent, par le contrat de Projets', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store, providers: { [PROJECTS_USAGE_PROVIDER]: projectsProvider() } });
        const out = await handlerFor(gitRepoGet)(ctx, { repoId: 1 });
        assert.equal(out.repo.projectCount, 2);
        assert.deepEqual(out.usage, [
            { projectId: 5, title: 'Boutique', status: 'active' },
            { projectId: 6, title: 'Sans titre', status: 'draft' }
        ]);
    });
});

describe('git.repoAdd', () => {
    const body = { provider: 'github' as const, owner: 'Gerem66', repo: 'DevEye', credentialId: 10 };

    it('refuse un jeton inconnu de cet espace', async () => {
        const store = fakeRepo();
        store.credentials.push(credential({ id: 10, workspace_id: 42 }));
        await assert.rejects(handlerFor(gitRepoAdd)(createTestContext({ repo: store }), body), failsWith('not_found'));
        assert.equal(store.repos.length, 0);
    });

    it('ajoute un dépôt chiffré à l’étage ouvert, demande sa première lecture, et le retrouve au lieu de le dupliquer', async () => {
        const store = fakeRepo();
        store.credentials.push(credential({ id: 10, workspace_id: 1 }), credential({ id: 11, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store });
        const requested = mountFakeSync();

        const first = await handlerFor(gitRepoAdd)(ctx, body);
        assert.deepEqual(
            [first.repo.owner, first.repo.repo, first.repo.credentialId, first.repo.projectCount],
            ['Gerem66', 'DevEye', 10, 0]
        );
        // Le harnais chiffre à l'identité : le couple est dans le blob, l'unicité
        // dans le condensé.
        assert.equal(store.repos[0].content, JSON.stringify({ owner: 'Gerem66', repo: 'DevEye' }));
        assert.equal(store.repos[0].slug_ref, slugRef('gerem66', 'deveye'));
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['git.repoAdd']
        );
        assert.deepEqual(requested, [first.repo.id]);

        // Idempotente sur `owner/repo`, casse comprise : la même ligne, avec
        // le jeton mis à jour, et une nouvelle lecture demandée.
        const again = await handlerFor(gitRepoAdd)(ctx, {
            ...body,
            owner: 'gerem66',
            repo: 'deveye',
            credentialId: 11
        });
        assert.equal(again.repo.id, first.repo.id);
        assert.equal(again.repo.credentialId, 11);
        assert.equal(store.repos.length, 1);
        assert.equal(ctx.recorded.audits.length, 1);
        assert.deepEqual(requested, [first.repo.id, first.repo.id]);
    });
});

describe('git.repoUpdate, git.repoRemove, git.repoReorder et git.repoResync', () => {
    it('règle un dépôt chez lui, et réveille la lecture quand un jeton arrive', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1, credential_id: null }));
        store.credentials.push(credential({ id: 10, workspace_id: 1 }));
        const requested = mountFakeSync();
        const out = await handlerFor(gitRepoUpdate)(createTestContext({ repo: store }), {
            repoId: 1,
            credentialId: 10,
            enabled: true
        });
        assert.deepEqual([out.repo.credentialId, out.repo.enabled], [10, true]);
        assert.deepEqual(requested, [1]);

        // Suspendre ne réveille rien.
        await handlerFor(gitRepoUpdate)(createTestContext({ repo: store }), {
            repoId: 1,
            credentialId: 10,
            enabled: false
        });
        assert.equal(store.repos[0].enabled, 0);
        assert.deepEqual(requested, [1]);
    });

    it('supprimer fait le ménage des projections, restrictions et route', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store });
        assert.deepEqual(await handlerFor(gitRepoRemove)(ctx, { repoId: 1 }), { repoId: 1 });
        assert.deepEqual(store.repos, []);
        assert.deepEqual(ctx.forgotten, [1]);
        assert.equal(ctx.recorded.audits[0].action, 'git.repoRemove');

        await assert.rejects(handlerFor(gitRepoRemove)(ctx, { repoId: 1 }), failsWith('not_found'));
    });

    it('range les dépôts dans l’ordre donné', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }), repo({ id: 2, workspace_id: 1 }));
        assert.deepEqual(await handlerFor(gitRepoReorder)(createTestContext({ repo: store }), { ids: [2, 1] }), {
            ids: [2, 1]
        });
        assert.deepEqual(
            store.repos.map((r) => [r.id, r.sort_order]),
            [
                [1, 1],
                [2, 0]
            ]
        );
    });

    it('resynchroniser jette le cache, l’audite, et réveille la lecture', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1, last_sync_at: 500 }));
        const ctx = createTestContext({ repo: store });
        const requested = mountFakeSync();
        const out = await handlerFor(gitRepoResync)(ctx, { repoId: 1 });
        assert.equal(out.repo.lastSyncAt, null);
        assert.deepEqual(store.reset, [1]);
        assert.equal(ctx.recorded.audits[0].action, 'git.repoResync');
        assert.deepEqual(requested, [1]);
    });
});

describe('l’avancement de la synchronisation', () => {
    it('sans service, rien n’est en cours et rien ne lève', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store });
        assert.deepEqual(await handlerFor(gitRepoSyncStatus)(ctx, { repoId: 1 }), {
            status: { running: false, phase: null, step: 0, stepCount: 1, startedAt: null }
        });
        assert.deepEqual(await handlerFor(gitSyncStatuses)(ctx, {}), { statuses: [] });
        // Un réveil sans service n'est pas une erreur : le prochain montage
        // prendra le dépôt, jamais synchronisé, en tête.
        await handlerFor(gitRepoSyncNow)(ctx, { repoId: 1 });
    });

    it('avec le service, lit son avancement en mémoire, derrière la frontière d’espace', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }), repo({ id: 2, workspace_id: 42 }));
        mountFakeSync();
        const ctx = createTestContext({ repo: store });
        const out = await handlerFor(gitRepoSyncStatus)(ctx, { repoId: 1 });
        assert.deepEqual(out.status, { running: true, phase: 'Commits', step: 2, stepCount: 6, startedAt: 1_001 });
        await assert.rejects(handlerFor(gitRepoSyncStatus)(ctx, { repoId: 2 }), failsWith('not_found'));
        assert.deepEqual(await handlerFor(gitSyncStatuses)(ctx, {}), {
            statuses: [{ repoId: 1, phase: 'Commits', step: 2, stepCount: 6 }]
        });
    });
});

describe('les jetons GitHub', () => {
    it('liste les jetons de l’espace avec leur usage, sans jamais rendre le secret', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }), repo({ id: 2, workspace_id: 1 }));
        store.credentials.push(
            credential({ id: 10, workspace_id: 1 }),
            credential({ id: 11, workspace_id: 1, label: 'Sans usage' }),
            credential({ id: 12, workspace_id: 42 })
        );
        const out = await handlerFor(gitCredentialList)(createTestContext({ repo: store }), {});
        assert.deepEqual(
            out.credentials.map((c) => [c.id, c.label, c.hasSecret, c.useCount]),
            [
                [10, 'Jeton 10', true, 2],
                [11, 'Sans usage', true, 0]
            ]
        );
        assert.ok(out.credentials.every((c) => !('secret' in c) && !('secretEnc' in c)));
    });

    it('ajoute un jeton chiffré à l’étage ouvert, audit `git.credentialAdd`', async () => {
        const store = fakeRepo();
        const ctx = createTestContext({ repo: store });
        const out = await handlerFor(gitCredentialAdd)(ctx, { label: 'Perso', secret: 'ghp-1' });
        assert.deepEqual([out.credential.label, out.credential.hasSecret, out.credential.useCount], ['Perso', true, 0]);
        // Le harnais chiffre à l'identité : le secret est dans sa colonne.
        assert.equal(store.credentials[0].secret_enc, 'ghp-1');
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['git.credentialAdd']
        );
    });

    it('un secret absent est conservé, un secret donné remplace l’ancien', async () => {
        const store = seed(fakeRepo(), repo({ id: 1, workspace_id: 1 }));
        store.credentials.push(credential({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo: store });
        const update = handlerFor(gitCredentialUpdate);

        const kept = await update(ctx, { credentialId: 10, label: 'Renommé' });
        assert.deepEqual([kept.credential.label, kept.credential.useCount], ['Renommé', 1]);
        assert.equal(store.credentials[0].secret_enc, 'ghp-secret');

        await update(ctx, { credentialId: 10, label: 'Renommé', secret: 'ghp-2' });
        assert.equal(store.credentials[0].secret_enc, 'ghp-2');

        await assert.rejects(update(ctx, { credentialId: 99, label: 'x' }), failsWith('not_found'));
    });

    it('retirer un jeton laisse ses dépôts, sans jeton, et répond `not_found` sur le jeton d’un autre espace', async () => {
        const store = seed(
            fakeRepo(),
            repo({ id: 1, workspace_id: 1 }),
            repo({ id: 2, workspace_id: 1, credential_id: 11 }),
            repo({ id: 3, workspace_id: 42, credential_id: 10 })
        );
        store.credentials.push(
            credential({ id: 10, workspace_id: 1 }),
            credential({ id: 11, workspace_id: 1 }),
            credential({ id: 10, workspace_id: 42 })
        );
        const ctx = createTestContext({ repo: store });

        assert.deepEqual(await handlerFor(gitCredentialRemove)(ctx, { credentialId: 10 }), { credentialId: 10 });
        // Le ménage explicite : le dépôt du jeton passe à NULL, les autres
        // gardent le leur, et l'espace voisin n'est pas touché.
        assert.deepEqual(
            store.repos.map((r) => [r.id, r.credential_id]),
            [
                [1, null],
                [2, 11],
                [3, 10]
            ]
        );
        assert.deepEqual(
            store.credentials.map((c) => [c.id, c.workspace_id]),
            [
                [11, 1],
                [10, 42]
            ]
        );
        assert.equal(ctx.recorded.audits[0].action, 'git.credentialRemove');

        await assert.rejects(handlerFor(gitCredentialRemove)(ctx, { credentialId: 12 }), failsWith('not_found'));
    });
});
