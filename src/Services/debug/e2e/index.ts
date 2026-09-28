import type { Logger } from 'pino';
import type { DebugE2eReport, DebugE2eScenario } from '@deveye/types';

import { FeatureError } from '@/features/_define';
import { moduleE2eEntries } from '@/features/_sdk/register';
import type { AuditLog } from '@/Services/AuditLog';
import { maintenance } from '@/Services/maintenance';
import { env } from '@/Utils/Env';
import type { Launcher, RunRegistry } from '../runs';
import type { Remover } from './accounts';
import { runGate } from './gate';
import { newRunId, testIdentity } from './identity';
import { pendingReport, runScenario } from './runner';
import { fromModule, type E2eDeps, type E2eScenario } from './scenario';
import { CORE_SCENARIOS } from './scenarios';
import { countResidue, sweepTestResidue } from './sweep';

const BOOT_SWEEP_DELAY_MS = 30_000;
const SITE_DOWN = 'Le site est en maintenance : les comptes d’essai ne pourraient pas se connecter.';
const PRIORITY_ON =
    'Priorité aux abonnés active : les comptes d’essai, sans abonnement, auraient tout en pause. Levez-la le temps des essais.';

/** Ce qui empêche tout essai sur ce serveur, dit tel quel dans la page. */
const blockedBy = (): string | null =>
    maintenance.siteDown() ? SITE_DOWN : maintenance.priority() ? PRIORITY_ON : null;

export interface E2eServiceDeps extends E2eDeps {
    runs: RunRegistry;
    audit: AuditLog;
    logger: Logger;
}

/** Les essais de bout en bout : des parcours réels, joués contre ce serveur même, qui ne laissent rien derrière eux. */
export function createE2e(deps: E2eServiceDeps) {
    const base = `http://127.0.0.1:${env.LISTEN_PORT}`;
    const system: Remover = { userId: 0, workspaceId: 0 };

    const scenarios = (): E2eScenario[] => [
        ...CORE_SCENARIOS,
        ...moduleE2eEntries(deps.db).flatMap(({ featureId, label, entry, repo }) =>
            entry.scenarios.map((sc) => fromModule(featureId, label, sc, repo))
        )
    ];

    const removerOf = async (launcher: Launcher): Promise<Remover> => {
        const row = await deps.db.users.findById(launcher.id);
        return { userId: launcher.id, workspaceId: row?.personal_workspace_id ?? 0 };
    };

    return {
        async catalog(): Promise<{ scenarios: DebugE2eScenario[]; residue: number; blocked: string | null }> {
            const list = await Promise.all(
                scenarios().map(async (sc) => ({
                    id: sc.id,
                    label: sc.label,
                    sourceLabel: sc.sourceLabel,
                    skip: (await sc.skip?.(deps)) ?? null
                }))
            );
            return {
                scenarios: list,
                residue: deps.runs.active() ? 0 : await countResidue(deps.db),
                blocked: blockedBy()
            };
        },

        async start(launcher: Launcher, ids: readonly string[]): Promise<number> {
            const blocked = blockedBy();
            if (blocked) throw new FeatureError(maintenance.siteDown() ? 'maintenance' : 'validation', blocked);
            const all = scenarios();
            const selected = all.filter((sc) => ids.includes(sc.id));
            const unknown = ids.filter((id) => !all.some((sc) => sc.id === id));
            if (unknown.length > 0) throw new FeatureError('validation', `Scénario inconnu : ${unknown.join(', ')}`);
            const by = await removerOf(launcher);
            const report: DebugE2eReport = {
                kind: 'e2e',
                scenarios: selected.map(pendingReport),
                residueAfter: null
            };
            return deps.runs.start(launcher, report, async ({ signal, report: live }) => {
                const runToken = runGate.open();
                const runId = newRunId();
                let identities = 0;
                let passed = true;
                try {
                    // Rien d'autre ne tourne ici (verrou) : un compte de ce serveur est un reste.
                    await sweepTestResidue(deps, by);
                    for (const [i, scenario] of selected.entries()) {
                        const ok = await runScenario(
                            scenario,
                            live.scenarios[i],
                            {
                                deps,
                                runToken,
                                nextIdentity: () => testIdentity(runId, ++identities),
                                base,
                                by
                            },
                            signal
                        );
                        passed &&= ok;
                    }
                } finally {
                    const { failures } = await sweepTestResidue(deps, by).catch((e: Error) => ({
                        failures: [e.message]
                    }));
                    live.residueAfter = await countResidue(deps.db);
                    passed &&= failures.length === 0 && live.residueAfter === 0;
                    runGate.close();
                    const counts = live.scenarios.reduce(
                        (acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }),
                        {} as Record<string, number>
                    );
                    deps.audit.record({
                        source: 'system',
                        category: 'debug',
                        action: 'debug.e2eRun',
                        level: passed ? 'info' : 'warning',
                        uid: launcher.id,
                        ip: '',
                        description: `Essais de bout en bout : ${counts.passed ?? 0} réussi(s), ${counts.failed ?? 0} en échec, ${counts.skipped ?? 0} ignoré(s), ${live.residueAfter} compte(s) restant(s)`,
                        metadata: { scenarios: live.scenarios.map((s) => `${s.id}:${s.status}`) }
                    });
                }
                return passed;
            });
        },

        /** Le ménage à la demande : jamais pendant un essai. */
        async sweep(launcher: Launcher): Promise<number> {
            const by = await removerOf(launcher);
            return deps.runs.withLock(async () => (await sweepTestResidue(deps, by)).removed);
        },

        /** Au démarrage, le temps que tout soit prêt : ce qu'un arrêt a interrompu s'efface. Un essai déjà lancé fait ce ménage lui-même. */
        scheduleBootSweep(): () => void {
            const timer = setTimeout(() => {
                deps.runs
                    .withLock(() => sweepTestResidue(deps, system))
                    .then(({ removed }) => {
                        if (removed > 0)
                            deps.logger.warn({ removed }, 'Comptes d’essai oubliés supprimés au démarrage');
                    })
                    .catch(() => undefined);
            }, BOOT_SWEEP_DELAY_MS);
            timer.unref();
            return () => clearTimeout(timer);
        }
    };
}

export type E2e = ReturnType<typeof createE2e>;
