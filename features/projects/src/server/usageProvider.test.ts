import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectEventRow, ProjectRow } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { serverEntry } from './index';
import type { ProjectsRepo, ProjectUsageRow } from './repo';

/**
 * Le contrat que le service publie (`PROJECTS_USAGE_PROVIDER`), sur le harnais
 * sessionless du SDK. Ce qui mérite d'être tenu : une feature inconnue vaut du vide
 * et jamais une erreur, les titres se lisent à l'étage ouvert avec un repli quand le
 * corps résiste, la frise d'un projet gardé ne s'écrit pas d'ici, et la version
 * d'une release ne se reporte que sur les projets ouverts qui l'ont demandée, en
 * ravivant le portefeuille seulement quand quelque chose a changé.
 */

function body(title: string, version = ''): string {
    return JSON.stringify({ title, icon: '', description: '', tags: [], version });
}

function project(over: Partial<ProjectRow> & { id: number }): ProjectRow {
    return {
        workspace_id: 1,
        user_id: 1,
        status: 'active',
        security_tier: 'open',
        version_source: 'manual',
        show_overview: 1,
        show_timeline: 1,
        sort_order: over.id,
        start_date: null,
        due_date: null,
        archived_at: null,
        content: body(`Projet ${over.id}`),
        created: 1,
        updated: 1,
        ...over
    };
}

async function unused(): Promise<never> {
    throw new Error('non attendu ici');
}

interface FakeRepo extends ProjectsRepo {
    projectRows: ProjectRow[];
    eventRows: ProjectEventRow[];
    /** `repoId → projets liés`, la seule liaison que ces tests traversent. */
    repoLinks: Map<number, number[]>;
    /** `espace → projets d'ailleurs qu'il voit`, pour éprouver le refus de relier une fenêtre. */
    projectedInto: Map<number, number[]>;
}

/**
 * Un dépôt réduit à ce que le contrat lit : les projets, la frise et les lectures
 * d'usage des dépôts git. Le reste lève s'il est atteint.
 */
function fakeRepo(): FakeRepo {
    const projectRows: ProjectRow[] = [];
    const eventRows: ProjectEventRow[] = [];
    const repoLinks = new Map<number, number[]>();
    const projectedInto = new Map<number, number[]>();
    const usageOf = async (repoId: number, ws: number): Promise<ProjectUsageRow[]> =>
        (repoLinks.get(repoId) ?? [])
            .map((id) => projectRows.find((p) => p.id === id && p.workspace_id === ws))
            .filter((p): p is ProjectRow => p !== undefined && p.security_tier === 'open')
            .map((p) => ({ project_id: p.id, status: p.status, content: p.content }));
    const links = {
        listServiceIds: unused,
        link: unused,
        unlink: unused,
        listByProject: unused,
        listDatabaseIds: unused,
        linkDatabase: unused,
        unlinkDatabase: unused,
        unlinkAllDatabases: unused,
        listDatabaseUsage: unused,
        countDatabaseLinks: unused,
        listDeployTargetIds: unused,
        linkDeployTarget: unused,
        unlinkDeployTarget: unused,
        unlinkAllDeployTargets: unused,
        listDeployUsage: unused,
        countDeployLinks: unused,
        listRepoIds: unused,
        async linkRepo(projectId: number, _ws: number, repoId: number) {
            const ids = repoLinks.get(repoId) ?? [];
            if (!ids.includes(projectId)) ids.push(projectId);
            repoLinks.set(repoId, ids);
        },
        async unlinkRepo(projectId: number, _ws: number, repoId: number) {
            const ids = (repoLinks.get(repoId) ?? []).filter((id) => id !== projectId);
            repoLinks.set(repoId, ids);
            return true;
        },
        unlinkAllRepos: unused,
        listRepoUsage: usageOf,
        countRepoLinks: async (ws: number) => {
            const counts = new Map<number, number>();
            for (const [repoId, ids] of repoLinks) {
                const n = ids.filter((id) => projectRows.some((p) => p.id === id && p.workspace_id === ws)).length;
                if (n > 0) counts.set(repoId, n);
            }
            return counts;
        },
        listSiteIds: unused,
        linkSite: unused,
        unlinkSite: unused,
        unlinkAllSites: unused,
        listSiteUsage: unused,
        countSiteLinks: unused,
        listPackIds: unused,
        linkPack: unused,
        unlinkPack: unused,
        unlinkAllPacks: unused,
        listPackUsage: unused,
        countPackLinks: unused,
        detachPack: unused,
        listServiceUsage: unused,
        countServiceLinks: unused,
        detachService: unused,
        detachDatabase: unused,
        detachDeployTarget: unused,
        detachRepo: unused,
        detachSite: unused
    } satisfies ProjectsRepo['links'];
    return {
        projectRows,
        eventRows,
        repoLinks,
        projectedInto,
        projects: {
            // Les projets que cet espace voit : les siens, et ceux qu'un autre
            // lui projette (`projectedInto`).
            listVisible: async (ws: number, archived: boolean) =>
                projectRows.filter(
                    (p) =>
                        (p.archived_at !== null) === archived &&
                        (p.workspace_id === ws || (projectedInto.get(ws) ?? []).includes(p.id))
                ),
            findById: async (id, ws) => projectRows.find((p) => p.id === id && p.workspace_id === ws) ?? null,
            findVisible: unused,
            create: unused,
            async update(id, ws, input) {
                const row = projectRows.find((p) => p.id === id && p.workspace_id === ws);
                if (!row) return null;
                row.content = input.content;
                return row;
            },
            setStatus: unused,
            setVersionSource: unused,
            setSecurityTier: unused,
            archive: unused,
            restore: unused,
            reorder: unused,
            statsFor: unused
        },
        board: {} as ProjectsRepo['board'],
        dashboard: {} as ProjectsRepo['dashboard'],
        chat: {} as ProjectsRepo['chat'],
        plan: {} as ProjectsRepo['plan'],
        history: {
            listByProject: unused,
            async record(input) {
                eventRows.push({
                    id: eventRows.length + 1,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    actor_user_id: input.actorUserId,
                    kind: input.kind,
                    ref_type: input.refType,
                    ref_id: input.refId,
                    created: 1,
                    content: input.content
                });
            }
        },
        links,
        rekey: {} as ProjectsRepo['rekey'],
        publication: {} as ProjectsRepo['publication']
    };
}

function providerOn(repo: FakeRepo) {
    const deps = createTestServiceDeps({ repo });
    const service = serverEntry.createService?.(deps);
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[PROJECTS_USAGE_PROVIDER] as ProjectsUsageProvider | undefined;
    assert.ok(provider, 'le service publie le contrat d’usage');
    return { deps, provider };
}

describe('PROJECTS_USAGE_PROVIDER : usageOf / countByItem', () => {
    it('rend les projets ouverts qui relient un élément, titre déchiffré, et compte par élément', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(
            project({ id: 1 }),
            project({ id: 2, security_tier: 'guarded', content: body('Secret') }),
            project({ id: 3, status: 'done', content: 'illisible' }),
            project({ id: 4, workspace_id: 7 })
        );
        repo.repoLinks.set(5, [1, 2, 3, 4]);
        const { provider } = providerOn(repo);
        assert.deepEqual(await provider.usageOf('git', 5, 1), [
            { projectId: 1, title: 'Projet 1', status: 'active' },
            // Un corps illisible garde le projet dans la liste, sous un titre de secours.
            { projectId: 3, title: 'Sans titre', status: 'done' }
        ]);
        assert.deepEqual([...(await provider.countByItem('git', 1))], [[5, 3]]);
    });

    it('une feature qui ne relie rien vaut vide, jamais une erreur', async () => {
        const { provider } = providerOn(fakeRepo());
        assert.deepEqual(await provider.usageOf('weather', 1, 1), []);
        assert.deepEqual([...(await provider.countByItem('weather', 1))], []);
        assert.equal(await provider.detach('weather', 1, 1), 0);
    });
});

describe('PROJECTS_USAGE_PROVIDER : recordEvent', () => {
    it('écrit la ligne de frise d’un projet ouvert sous le codec ouvert et ravive le sujet', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(project({ id: 1 }));
        const { deps, provider } = providerOn(repo);
        await provider.recordEvent(1, 1, { kind: 'deploy.triggered', label: 'Prod', actorUserId: 4 });
        assert.deepEqual(
            repo.eventRows.map((e) => [e.project_id, e.kind, e.actor_user_id, JSON.parse(e.content)]),
            [[1, 'deploy.triggered', 4, { label: 'Prod', from: null, to: null }]]
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('ignore en silence un projet gardé, inconnu ou d’un autre espace', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(project({ id: 2, security_tier: 'guarded' }), project({ id: 3, workspace_id: 7 }));
        const { deps, provider } = providerOn(repo);
        const event = { kind: 'deploy.triggered', label: 'Prod', actorUserId: null };
        await provider.recordEvent(2, 1, event);
        await provider.recordEvent(3, 1, event);
        await provider.recordEvent(9, 1, event);
        assert.deepEqual(repo.eventRows, []);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });
});

describe('PROJECTS_USAGE_PROVIDER : applyVersion', () => {
    it('reporte la release sur les seuls projets ouverts qui la suivent, et ravive le portefeuille', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(
            project({ id: 1, version_source: 'github_release', content: body('Suit', '1.0.0') }),
            project({ id: 2, version_source: 'manual', content: body('Manuel', '0.1.0') }),
            project({ id: 3, version_source: 'github_release', content: body('Déjà', '2.0.0') })
        );
        repo.repoLinks.set(5, [1, 2, 3]);
        const { deps, provider } = providerOn(repo);
        await provider.applyVersion('git', 5, 1, '2.0.0');
        assert.deepEqual(
            repo.projectRows.map((p) => JSON.parse(p.content).version),
            ['2.0.0', '0.1.0', '2.0.0']
        );
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('ne ravive personne quand rien ne change, ni pour une feature sans source de version', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(project({ id: 3, version_source: 'github_release', content: body('Déjà', '2.0.0') }));
        repo.repoLinks.set(5, [3]);
        const { deps, provider } = providerOn(repo);
        await provider.applyVersion('git', 5, 1, '2.0.0');
        await provider.applyVersion('database', 5, 1, '3.0.0');
        assert.deepEqual(deps.recorded.liveChanges, []);
        assert.equal(JSON.parse(repo.projectRows[0].content).version, '2.0.0');
    });
});

describe('PROJECTS_USAGE_PROVIDER : linkTargets / link / unlink', () => {
    it('propose les projets ouverts de l’espace, l’archivé seulement s’il relie encore', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(
            project({ id: 1 }),
            project({ id: 2, security_tier: 'guarded', content: body('Gardé') }),
            project({ id: 3, archived_at: 10, content: body('Rangé relié') }),
            project({ id: 4, archived_at: 10, content: body('Rangé libre') }),
            project({ id: 5, workspace_id: 7, content: body('Projeté') })
        );
        // Le projet de l'espace 7 est visible d'ici, mais on n'y pose rien.
        repo.projectedInto.set(1, [5]);
        repo.repoLinks.set(9, [1, 3]);
        const { provider } = providerOn(repo);
        assert.deepEqual(await provider.linkTargets('git', 9, 1), [
            { projectId: 1, title: 'Projet 1', status: 'active', archived: false, linked: true },
            { projectId: 3, title: 'Rangé relié', status: 'active', archived: true, linked: true }
        ]);
    });

    it('une feature qui ne relie rien vaut vide, jamais une erreur', async () => {
        const { provider } = providerOn(fakeRepo());
        assert.deepEqual(await provider.linkTargets('weather', 1, 1), []);
        await provider.link('weather', 1, 1, 1);
        await provider.unlink('weather', 1, 1, 1);
    });

    it('pose et retire la liaison, deux fois sans broncher, en ravivant l’espace du projet', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(project({ id: 1 }));
        const { deps, provider } = providerOn(repo);
        await provider.link('git', 9, 1, 1);
        await provider.link('git', 9, 1, 1);
        assert.deepEqual(repo.repoLinks.get(9), [1]);
        await provider.unlink('git', 9, 1, 1);
        assert.deepEqual(repo.repoLinks.get(9), []);
        assert.deepEqual(deps.recorded.liveChanges, [1, 1, 1]);
    });

    it('ne relie ni un projet gardé, ni un projet d’un autre espace, sans rien raviver', async () => {
        const repo = fakeRepo();
        repo.projectRows.push(project({ id: 2, security_tier: 'guarded' }), project({ id: 5, workspace_id: 7 }));
        repo.projectedInto.set(1, [5]);
        const { deps, provider } = providerOn(repo);
        await provider.link('git', 9, 1, 2);
        await provider.link('git', 9, 1, 5);
        assert.equal(repo.repoLinks.get(9), undefined);
        assert.deepEqual(deps.recorded.liveChanges, []);
    });
});
