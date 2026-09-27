import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pendingReport, runScenario, type RunnerEnv } from './runner';
import type { E2eDeps, E2eScenario } from './scenario';

const env: RunnerEnv = {
    deps: {} as E2eDeps,
    runToken: 'jeton',
    nextIdentity: () => ({ username: 'e2e', email: 'e2e@e2e.deveye.invalid', password: 'x' }),
    base: 'http://127.0.0.1:1',
    by: { userId: 1, workspaceId: 1 }
};

const scenario = (steps: E2eScenario['steps'], skip?: E2eScenario['skip']): E2eScenario => ({
    id: 'core.essai',
    label: 'Essai',
    sourceLabel: 'DevEye',
    accounts: 0,
    skip,
    steps
});

describe('l’exécuteur des scénarios', () => {
    it('chronomètre chaque étape, garde son détail, et fait le ménage', async () => {
        const undone: string[] = [];
        const sc = scenario([
            {
                label: 'Créer',
                run: async (ctx) => {
                    ctx.ledger.defer('Défaire', async () => void undone.push('défait'));
                    return 'Créé';
                }
            },
            { label: 'Vérifier', run: async () => undefined }
        ]);
        const entry = pendingReport(sc);
        assert.equal(await runScenario(sc, entry, env, new AbortController().signal), true);
        assert.equal(entry.status, 'passed');
        assert.deepEqual(
            entry.steps.map((s) => [s.status, s.detail]),
            [
                ['passed', 'Créé'],
                ['passed', null]
            ]
        );
        assert.ok(entry.steps.every((s) => s.durationMs !== null));
        assert.deepEqual(entry.cleanup, { ok: true, detail: null });
        assert.deepEqual(undone, ['défait']);
    });

    it('au premier échec, la suite est ignorée et le ménage a lieu quand même', async () => {
        let cleaned = false;
        const sc = scenario([
            {
                label: 'Créer',
                run: async (ctx) => {
                    ctx.ledger.defer('Défaire', async () => {
                        cleaned = true;
                    });
                }
            },
            {
                label: 'Casser',
                run: async () => {
                    throw new Error('Refusé');
                }
            },
            { label: 'Jamais', run: async () => undefined }
        ]);
        const entry = pendingReport(sc);
        assert.equal(await runScenario(sc, entry, env, new AbortController().signal), false);
        assert.deepEqual(
            entry.steps.map((s) => s.status),
            ['passed', 'failed', 'skipped']
        );
        assert.equal(entry.steps[1].detail, 'Refusé');
        assert.equal(cleaned, true);
    });

    it('un ménage raté fait échouer le scénario, une étape trop longue aussi', async () => {
        const sc = scenario([
            {
                label: 'Créer',
                timeoutMs: 20,
                run: async (ctx) => {
                    ctx.ledger.defer('Défaire', async () => {
                        throw new Error('résiste');
                    });
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }
        ]);
        const entry = pendingReport(sc);
        assert.equal(await runScenario(sc, entry, env, new AbortController().signal), false);
        assert.match(entry.steps[0].detail ?? '', /Délai dépassé/);
        assert.deepEqual(entry.cleanup, { ok: false, detail: 'Défaire : résiste' });
    });

    it('un scénario ignoré le dit, et ne compte pas comme un échec', async () => {
        const sc = scenario([{ label: 'Rien', run: async () => undefined }], () => 'Pas ici');
        const entry = pendingReport(sc);
        assert.equal(await runScenario(sc, entry, env, new AbortController().signal), true);
        assert.equal(entry.status, 'skipped');
        assert.equal(entry.skipReason, 'Pas ici');
        assert.equal(entry.steps[0].status, 'skipped');
    });

    it('les comptes demandés s’annoncent en première étape', () => {
        const entry = pendingReport({ ...scenario([]), accounts: 2 });
        assert.equal(entry.steps[0].label, 'Ouvrir 2 comptes d’essai');
    });
});
