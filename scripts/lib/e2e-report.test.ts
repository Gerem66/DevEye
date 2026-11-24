import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DebugE2eScenario, DebugE2eScenarioReport, DebugRun } from '@deveye/types';

import { batchesOf, e2eVerdict, parseSkips, scenarioLine, selectScenarios, staleSkips } from './e2e-report';

function scenario(id: string, over: Partial<DebugE2eScenarioReport> = {}): DebugE2eScenarioReport {
    return {
        id,
        label: id,
        sourceLabel: 'DevEye',
        status: 'passed',
        skipReason: null,
        durationMs: 1200,
        steps: [{ label: 'Faire', status: 'passed', durationMs: 1200, detail: null }],
        cleanup: { ok: true, detail: null },
        ...over
    };
}

function run(
    scenarios: DebugE2eScenarioReport[],
    over: Partial<DebugRun> = {},
    residueAfter: number | null = 0
): DebugRun {
    return {
        id: 7,
        status: 'passed',
        startedAt: 0,
        finishedAt: 1,
        launchedBy: null,
        report: { kind: 'e2e', scenarios, residueAfter },
        ...over
    };
}

const entry = (id: string, external: string | null = null): DebugE2eScenario => ({
    id,
    label: id,
    sourceLabel: 'DevEye',
    skip: null,
    external
});

describe('e2eVerdict', () => {
    it('passe quand tout a réussi et que rien ne reste', () => {
        assert.deepEqual(e2eVerdict([run([scenario('core.account'), scenario('notes.lifecycle')])], new Set()), {
            ok: true,
            problems: []
        });
    });

    it('échoue sur une étape ratée, et la nomme avec son détail', () => {
        const failed = scenario('notes.lifecycle', {
            status: 'failed',
            steps: [
                { label: 'Créer', status: 'passed', durationMs: 10, detail: null },
                { label: 'Relire', status: 'failed', durationMs: 10, detail: 'Note introuvable' },
                { label: 'Supprimer', status: 'skipped', durationMs: null, detail: null }
            ]
        });
        const verdict = e2eVerdict([run([failed], { status: 'failed' })], new Set());
        assert.equal(verdict.ok, false);
        assert.deepEqual(verdict.problems, ['notes.lifecycle : étape « Relire » : Note introuvable']);
    });

    it('échoue sur un ménage incomplet, même quand chaque étape a réussi', () => {
        const dirty = scenario('whiteboard.lifecycle', {
            status: 'failed',
            cleanup: { ok: false, detail: 'Supprimer le tableau : conflit' }
        });
        const verdict = e2eVerdict([run([dirty], { status: 'failed' })], new Set());
        assert.deepEqual(verdict.problems, [
            'whiteboard.lifecycle : ménage incomplet : Supprimer le tableau : conflit'
        ]);
    });

    it('échoue sur un compte d’essai resté en base', () => {
        const verdict = e2eVerdict([run([scenario('core.account')], { status: 'failed' }, 2)], new Set());
        assert.deepEqual(verdict.problems, ['essai 7 : 2 compte(s) d’essai restent en base']);
    });

    it('échoue quand le ménage final n’a pas eu lieu', () => {
        const verdict = e2eVerdict([run([scenario('core.account')], { status: 'aborted' }, null)], new Set());
        assert.deepEqual(verdict.problems, ['essai 7 : le ménage final n’a pas eu lieu']);
    });

    it('échoue sur un parcours ignoré que personne n’attendait', () => {
        const skipped = scenario('uptime.monitor', {
            status: 'skipped',
            skipReason: 'adresse privée',
            cleanup: null
        });
        const verdict = e2eVerdict([run([skipped])], new Set());
        assert.equal(verdict.ok, false);
        assert.match(verdict.problems[0], /^uptime\.monitor : ignoré sans être attendu \(adresse privée\)/);
    });

    it('laisse passer un parcours ignoré quand il est attendu', () => {
        const skipped = scenario('uptime.monitor', { status: 'skipped', skipReason: 'adresse privée', cleanup: null });
        assert.equal(e2eVerdict([run([skipped])], new Set(['uptime.monitor'])).ok, true);
    });

    it('échoue sur un parcours resté en attente', () => {
        const pending = scenario('core.sharing', { status: 'pending', durationMs: null, cleanup: null });
        const verdict = e2eVerdict([run([pending], { status: 'aborted' })], new Set());
        assert.deepEqual(verdict.problems, ['core.sharing : n’a pas tourné jusqu’au bout']);
    });

    it('échoue sur un essai que le serveur dit raté sans parcours fautif', () => {
        const verdict = e2eVerdict([run([scenario('core.account')], { status: 'failed' })], new Set());
        assert.equal(verdict.ok, false);
        assert.match(verdict.problems[0], /^essai 7 : terminé « failed » sans parcours fautif/);
    });

    it('juge tous les essais d’un tour', () => {
        const bad = scenario('pdf.savedSignature', {
            status: 'failed',
            steps: [{ label: 'Enregistrer', status: 'failed', durationMs: 5, detail: 'refus' }]
        });
        const verdict = e2eVerdict(
            [run([scenario('core.account')]), run([bad], { id: 8, status: 'failed' })],
            new Set()
        );
        assert.deepEqual(verdict.problems, ['pdf.savedSignature : étape « Enregistrer » : refus']);
    });
});

describe('selectScenarios', () => {
    const catalog = [entry('core.account'), entry('x-audit.report', 'GitHub'), entry('notes.lifecycle')];

    it('laisse de côté ce qui dépend d’un tiers', () => {
        const picked = selectScenarios(catalog, { only: [], external: false });
        assert.deepEqual(picked.ids, ['core.account', 'notes.lifecycle']);
        assert.deepEqual(
            picked.external.map((s) => s.id),
            ['x-audit.report']
        );
    });

    it('prend tout quand les tiers sont demandés', () => {
        const picked = selectScenarios(catalog, { only: [], external: true });
        assert.deepEqual(picked.ids, ['core.account', 'x-audit.report', 'notes.lifecycle']);
        assert.deepEqual(picked.external, []);
    });

    it('lance ce qu’on nomme, tiers compris, et signale un nom inconnu', () => {
        const picked = selectScenarios(catalog, { only: ['x-audit.report', 'notes.absent'], external: false });
        assert.deepEqual(picked.ids, ['x-audit.report']);
        assert.deepEqual(picked.unknown, ['notes.absent']);
    });
});

describe('les utilitaires du tour', () => {
    it('découpe par lots sans rien perdre', () => {
        const ids = Array.from({ length: 120 }, (_, i) => `m.s${i}`);
        const batches = batchesOf(ids);
        assert.deepEqual(
            batches.map((b) => b.length),
            [50, 50, 20]
        );
        assert.deepEqual(batches.flat(), ids);
    });

    it('lit la liste des sauts attendus, espaces et vides compris', () => {
        assert.deepEqual(
            [...parseSkips(' uptime.monitor, ,uptime.deployHook ')],
            ['uptime.monitor', 'uptime.deployHook']
        );
        assert.equal(parseSkips(undefined).size, 0);
    });

    it('repère un saut attendu que le catalogue ne connaît plus', () => {
        assert.deepEqual(staleSkips([entry('core.account')], new Set(['core.account', 'uptime.gone'])), [
            'uptime.gone'
        ]);
    });

    it('imprime un parcours selon son sort', () => {
        assert.equal(scenarioLine(scenario('core.account')), '✓ core.account (1.2 s)');
        assert.equal(
            scenarioLine(
                scenario('uptime.monitor', { status: 'skipped', skipReason: 'adresse privée', durationMs: null })
            ),
            '- uptime.monitor : ignoré, adresse privée'
        );
        assert.equal(
            scenarioLine(scenario('notes.lifecycle', { status: 'failed', durationMs: 300 })),
            '✗ notes.lifecycle (0.3 s)'
        );
    });
});
