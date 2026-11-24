import type { DebugE2eScenario, DebugE2eScenarioReport, DebugRun } from '@deveye/types';

/** Le plafond de `debug.e2eStart`. */
export const E2E_BATCH = 50;

export interface E2eSelection {
    ids: string[];
    /** Laissés de côté parce qu'ils dépendent d'un tiers. */
    external: DebugE2eScenario[];
    /** Demandés, absents du catalogue. */
    unknown: string[];
}

/**
 * Les parcours à lancer : ceux qu'on nomme, tels quels, ou tous ceux qui ne
 * dépendent que de ce serveur. Un parcours que le catalogue annonce ignoré
 * part quand même : c'est le rapport qui dit pourquoi, et le verdict qui juge.
 */
export function selectScenarios(
    catalog: readonly DebugE2eScenario[],
    { only, external }: { only: readonly string[]; external: boolean }
): E2eSelection {
    if (only.length > 0) {
        const known = new Set(catalog.map((s) => s.id));
        return {
            ids: only.filter((id) => known.has(id)),
            external: [],
            unknown: only.filter((id) => !known.has(id))
        };
    }
    const left = external ? [] : catalog.filter((s) => s.external !== null);
    return { ids: catalog.filter((s) => !left.includes(s)).map((s) => s.id), external: left, unknown: [] };
}

export function batchesOf<T>(items: readonly T[], size = E2E_BATCH): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export function parseSkips(raw: string | undefined): Set<string> {
    return new Set(
        (raw ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    );
}

const seconds = (ms: number | null): string => (ms === null ? '' : ` (${(ms / 1000).toFixed(1)} s)`);

/** Un parcours tel que le tour l'imprime, une fois fini. */
export function scenarioLine(scenario: DebugE2eScenarioReport): string {
    if (scenario.status === 'passed') return `✓ ${scenario.id}${seconds(scenario.durationMs)}`;
    if (scenario.status === 'skipped') return `- ${scenario.id} : ignoré, ${scenario.skipReason ?? 'sans raison'}`;
    return `✗ ${scenario.id}${seconds(scenario.durationMs)}`;
}

function scenarioProblems(scenario: DebugE2eScenarioReport, expectedSkips: ReadonlySet<string>): string[] {
    switch (scenario.status) {
        case 'passed':
            return [];
        case 'skipped':
            return expectedSkips.has(scenario.id)
                ? []
                : [
                      `${scenario.id} : ignoré sans être attendu (${scenario.skipReason ?? 'sans raison'}). ` +
                          'S’il ne peut pas tourner ici, nommez-le dans E2E_EXPECTED_SKIPS.'
                  ];
        case 'failed': {
            const out = scenario.steps
                .filter((s) => s.status === 'failed')
                .map((s) => `${scenario.id} : étape « ${s.label} » : ${s.detail ?? 'sans détail'}`);
            if (scenario.cleanup && !scenario.cleanup.ok) {
                out.push(`${scenario.id} : ménage incomplet : ${scenario.cleanup.detail ?? 'sans détail'}`);
            }
            return out.length > 0 ? out : [`${scenario.id} : en échec sans étape fautive`];
        }
        default:
            return [`${scenario.id} : n’a pas tourné jusqu’au bout`];
    }
}

/**
 * Ce qu'un tour de parcours vaut : il échoue sur une étape ratée, un ménage
 * incomplet, un compte d'essai resté en base, un parcours ignoré que
 * `expectedSkips` ne nomme pas, ou un essai que le serveur n'a pas déclaré
 * réussi.
 */
export function e2eVerdict(
    runs: readonly DebugRun[],
    expectedSkips: ReadonlySet<string>
): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    for (const run of runs) {
        if (run.report.kind !== 'e2e') {
            problems.push(`essai ${run.id} : ce n’est pas un essai de bout en bout`);
            continue;
        }
        const before = problems.length;
        for (const scenario of run.report.scenarios) problems.push(...scenarioProblems(scenario, expectedSkips));
        const residue = run.report.residueAfter;
        if (residue === null) problems.push(`essai ${run.id} : le ménage final n’a pas eu lieu`);
        else if (residue > 0) problems.push(`essai ${run.id} : ${residue} compte(s) d’essai restent en base`);
        if (run.status !== 'passed' && problems.length === before) {
            problems.push(
                `essai ${run.id} : terminé « ${run.status} » sans parcours fautif, le ménage final a échoué (journal du serveur)`
            );
        }
    }
    return { ok: problems.length === 0, problems };
}

/** Les sauts attendus que le catalogue ne connaît pas : une liste qui a vieilli. */
export function staleSkips(catalog: readonly DebugE2eScenario[], expectedSkips: ReadonlySet<string>): string[] {
    const known = new Set(catalog.map((s) => s.id));
    return [...expectedSkips].filter((id) => !known.has(id));
}
