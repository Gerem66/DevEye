import type { DebugE2eScenarioReport, DebugE2eStep } from '@deveye/types';

import { openTestAccount, removeTestAccount, signIn, type Remover, type TestSession } from './accounts';
import { createTestClient } from './client';
import type { TestIdentity } from './identity';
import { createLedger } from './ledger';
import type { E2eContext, E2eDeps, E2eScenario, E2eStep } from './scenario';

const STEP_MS = 20_000;
const SCENARIO_MS = 120_000;
const DETAIL_MAX = 300;

export interface RunnerEnv {
    deps: E2eDeps;
    /** Le jeton de l'essai, que portent toutes ses requêtes. */
    runToken: string;
    /** Unique sur tout l'essai : deux scénarios n'ouvrent jamais le même compte. */
    nextIdentity(): TestIdentity;
    base: string;
    by: Remover;
}

const cap = (text: string): string => (text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text);

/** Les étapes telles que le rapport les montre : l'ouverture des comptes d'abord, quand il en faut. */
function stepsOf(scenario: E2eScenario): readonly E2eStep[] {
    if (scenario.accounts === 0) return scenario.steps;
    const opening: E2eStep = {
        label: scenario.accounts === 1 ? 'Ouvrir un compte d’essai' : `Ouvrir ${scenario.accounts} comptes d’essai`,
        run: async () => undefined
    };
    return [opening, ...scenario.steps];
}

export function pendingReport(scenario: E2eScenario): DebugE2eScenarioReport {
    return {
        id: scenario.id,
        label: scenario.label,
        sourceLabel: scenario.sourceLabel,
        status: 'pending',
        skipReason: null,
        durationMs: null,
        steps: stepsOf(scenario).map((s) => ({ label: s.label, status: 'pending', durationMs: null, detail: null })),
        cleanup: null
    };
}

function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Délai dépassé (${Math.round(ms / 1000)} s)`)), ms);
        const onAbort = (): void => reject(new Error('Essai arrêté ou scénario trop long'));
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        });
    });
}

async function openAccounts(ctx: E2eContext, env: RunnerEnv, count: number): Promise<string> {
    for (let i = 0; i < count; i++) {
        const identity = ctx.newIdentity();
        const { userId, workspaceId } = await openTestAccount(env.deps.db, identity);
        // Inscrit avant toute autre chose : défait en dernier, il emporte ce que le compte possède.
        ctx.ledger.defer(`Supprimer ${identity.username}`, () => ctx.removeAccount({ userId, email: identity.email }));
        const client = ctx.newClient();
        await signIn(client, identity);
        ctx.accounts.push({ ...identity, userId, workspaceId, client } satisfies TestSession);
    }
    return ctx.accounts.map((a) => a.username).join(', ');
}

/**
 * Un scénario de bout en bout : ses étapes dans l'ordre, arrêtées au premier
 * échec, puis son ménage quoi qu'il arrive. Le rapport se remplit en place :
 * la page le relit pendant l'essai. Rend `false` si une étape ou le ménage a
 * échoué.
 */
export async function runScenario(
    scenario: E2eScenario,
    entry: DebugE2eScenarioReport,
    env: RunnerEnv,
    runSignal: AbortSignal
): Promise<boolean> {
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(SCENARIO_MS)]);
    const ledger = createLedger();
    const ctx: E2eContext = {
        deps: env.deps,
        signal,
        accounts: [],
        newIdentity: env.nextIdentity,
        newClient: () => {
            const client = createTestClient({ base: env.base, runToken: env.runToken, signal });
            ledger.defer('Fermer une socket', async () => client.close());
            return client;
        },
        ledger,
        state: new Map(),
        removeAccount: (account) => removeTestAccount(env.deps, account, env.by)
    };
    const started = performance.now();
    entry.status = 'running';
    let failed = false;
    try {
        const reason = await scenario.skip?.(env.deps);
        if (reason) {
            entry.status = 'skipped';
            entry.skipReason = reason;
            for (const s of entry.steps) s.status = 'skipped';
            return true;
        }
        const steps = stepsOf(scenario);
        for (const [i, step] of steps.entries()) {
            const report: DebugE2eStep = entry.steps[i];
            if (failed || signal.aborted) {
                report.status = 'skipped';
                continue;
            }
            report.status = 'running';
            const t0 = performance.now();
            try {
                const work =
                    i === 0 && scenario.accounts > 0 ? openAccounts(ctx, env, scenario.accounts) : step.run(ctx);
                const detail = await withTimeout(work, step.timeoutMs ?? STEP_MS, signal);
                report.status = 'passed';
                report.detail = detail ? cap(detail) : null;
            } catch (e) {
                failed = true;
                report.status = 'failed';
                report.detail = cap(e instanceof Error ? e.message : String(e));
            } finally {
                report.durationMs = Math.round(performance.now() - t0);
            }
        }
    } finally {
        if (entry.status !== 'skipped') {
            const cleanup = await ledger.cleanup();
            entry.cleanup = {
                ok: cleanup.ok,
                detail: cleanup.failures.length ? cap(cleanup.failures.join('\n')) : null
            };
            failed ||= !cleanup.ok;
            entry.status = failed ? 'failed' : 'passed';
            entry.durationMs = Math.round(performance.now() - started);
        }
    }
    return !failed;
}
