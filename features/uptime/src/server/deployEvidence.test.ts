import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    PROJECTS_USAGE_PROVIDER,
    type DeployActivity,
    type DeployItemsProvider,
    type GitItemsProvider,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import type { SdkProviders } from '@deveye/types/sdk/server';

import { DEPLOY_GRACE_SECONDS, DEPLOY_MARGIN_SECONDS, deployWindowStart, findDeployEvidence } from './deployEvidence';

const QUIET: DeployActivity = { succeeded: null, inFlight: null, error: null };

function providers(entries: Record<string, unknown>): SdkProviders {
    return { get: <T>(key: string) => entries[key] as T | undefined };
}

/** Un module qui répond, par identifiant, ce que le test lui fait dire, et retient qui on lui a demandé. */
function activityOf(answers: Record<number, DeployActivity | Error>) {
    const asked: number[] = [];
    return {
        asked,
        activity: async (id: number) => {
            asked.push(id);
            const answer = answers[id] ?? QUIET;
            if (answer instanceof Error) throw answer;
            return answer;
        }
    };
}

function deployProvider(answers: Record<number, DeployActivity | Error>) {
    const { asked, activity } = activityOf(answers);
    const provider = { activity } as unknown as DeployItemsProvider;
    return { asked, provider };
}

function gitProvider(answers: Record<number, DeployActivity | Error>) {
    const { asked, activity } = activityOf(answers);
    const provider = { activity } as unknown as GitItemsProvider;
    return { asked, provider };
}

describe('la fenêtre d’un déploiement', () => {
    it('part de la dernière lecture conforme moins la marge, sans remonter au-delà du rythme plus la grâce', () => {
        const now = 100_000;
        assert.equal(deployWindowStart(99_000, now, 900), 99_000 - DEPLOY_MARGIN_SECONDS);
        assert.equal(deployWindowStart(10_000, now, 900), now - 900 - DEPLOY_GRACE_SECONDS);
        assert.equal(deployWindowStart(null, now, 900), now - 900 - DEPLOY_GRACE_SECONDS);
    });
});

describe('les sources d’un service', () => {
    const base = { workspaceId: 1, since: 1000, hookAt: null };

    it('rend le succès le plus récent, toutes catégories confondues', async () => {
        const deploy = deployProvider({ 5: { ...QUIET, succeeded: { at: 1200, what: 'le déploiement « api »' } } });
        const git = gitProvider({ 8: { ...QUIET, succeeded: { at: 1500, what: 'le workflow « Deploy » de o/r' } } });
        const evidence = await findDeployEvidence({
            ...base,
            sources: [
                { kind: 'deploy', id: 5 },
                { kind: 'git', id: 8 }
            ],
            providers: providers({ [DEPLOY_ITEMS_PROVIDER]: deploy.provider, [GIT_ITEMS_PROVIDER]: git.provider })
        });
        assert.deepEqual(evidence, { kind: 'deployed', at: 1500, what: 'le workflow « Deploy » de o/r' });
    });

    it('un projet vaut ses cibles et ses dépôts, chacun demandé une fois', async () => {
        const deploy = deployProvider({ 6: { ...QUIET, inFlight: { what: 'le déploiement « web »' } } });
        const git = gitProvider({});
        const projects = {
            linkedItems: async (id: number) => (id === 3 ? { deploy: [5, 6], git: [8] } : { deploy: [], git: [] })
        } as unknown as ProjectsUsageProvider;
        const evidence = await findDeployEvidence({
            ...base,
            sources: [
                { kind: 'project', id: 3 },
                { kind: 'deploy', id: 5 }
            ],
            providers: providers({
                [DEPLOY_ITEMS_PROVIDER]: deploy.provider,
                [GIT_ITEMS_PROVIDER]: git.provider,
                [PROJECTS_USAGE_PROVIDER]: projects
            })
        });
        assert.deepEqual(evidence, { kind: 'inFlight', what: 'le déploiement « web »' });
        assert.deepEqual(deploy.asked.sort(), [5, 6]);
        assert.deepEqual(git.asked, [8]);
    });

    it('dit ce qui a empêché de savoir, et une source dont le module manque reste muette', async () => {
        const git = gitProvider({
            8: { ...QUIET, error: 'Dépôt o/r : le jeton ne lit pas les workflows (droit Actions en lecture)' },
            9: new Error('GitHub injoignable')
        });
        const evidence = await findDeployEvidence({
            ...base,
            sources: [
                { kind: 'deploy', id: 5 },
                { kind: 'git', id: 8 },
                { kind: 'git', id: 9 }
            ],
            providers: providers({ [GIT_ITEMS_PROVIDER]: git.provider })
        });
        assert.deepEqual(evidence, {
            kind: 'none',
            errors: ['Dépôt o/r : le jeton ne lit pas les workflows (droit Actions en lecture)', 'GitHub injoignable']
        });
    });

    it('l’adresse d’appel compte quand elle a été appelée dans la fenêtre', async () => {
        const inside = await findDeployEvidence({ ...base, hookAt: 1100, sources: [], providers: providers({}) });
        assert.deepEqual(inside, { kind: 'deployed', at: 1100, what: 'l’adresse d’appel' });
        const before = await findDeployEvidence({ ...base, hookAt: 900, sources: [], providers: providers({}) });
        assert.deepEqual(before, { kind: 'none', errors: [] });
    });
});
