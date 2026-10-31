import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DebugLoadReport } from '@deveye/types';
import type { SdkOrigins } from '@deveye/types/sdk/server';

import { hashPassword } from '@/auth/argon';
import type { AuditLog } from '@/Services/AuditLog';
import { env } from '@/Utils/Env';
import { assertRunnable } from '../e2e';
import { removerOf } from '../e2e/accounts';
import { runGate } from '../e2e/gate';
import { newRunId, testIdentity } from '../e2e/identity';
import { countResidue, sweepTestResidue, type SweepDeps } from '../e2e/sweep';
import type { Launcher, RunRegistry } from '../runs';
import { discoverActions, type CommandSpec } from './actions';
import { analyze, saturation } from './analysis';
import { createMeter, type Meter } from './meter';
import { simulateUser, type UserEnv } from './user';

/** Le palier au seuil, après la montée : le régime établi. */
const HOLD_MS = 30_000;
const TICK_MS = 250;
/** Les arrivées en vol à la fois : chacune vérifie un mot de passe Argon2, sur un pool de quatre fils. */
const MAX_ARRIVING = 4;

export interface LoadDeps extends SweepDeps {
    audit: AuditLog;
    runs: RunRegistry;
    origins: SdkOrigins;
    /** Les commandes du dispatcheur : ce qu'un utilisateur simulé sait envoyer. */
    commands: readonly CommandSpec[];
    wsSockets(): number;
    agentsOnline(): number;
}

/**
 * La montée en charge : des utilisateurs simulés ajoutés petit à petit jusqu'à
 * un seuil, contre ce serveur même, pour un ordre de grandeur de ce qu'il
 * tient. Comme les parcours, elle ne laisse rien derrière elle.
 */
export function createLoad(deps: LoadDeps) {
    const base = `http://127.0.0.1:${env.LISTEN_PORT}`;
    const host = new URL(deps.origins.app).host;

    return {
        async start(launcher: Launcher, settings: DebugLoadReport['settings']): Promise<number> {
            assertRunnable();
            const by = await removerOf(deps.db, launcher);
            const actions = discoverActions(deps.commands);
            const report: DebugLoadReport = {
                kind: 'load',
                settings,
                phase: 'prepare',
                bucketS: settings.durationMin <= 5 ? 5 : 10,
                writes: actions.writes,
                samples: [],
                features: [],
                arrivals: { n: 0, failed: 0, p50: null, p95: null },
                baselineP95: null,
                degradedAt: null,
                saturatedAt: null,
                residueAfter: null
            };
            return deps.runs.start(launcher, report, async ({ signal, report: live }) => {
                const runToken = runGate.open();
                const runId = newRunId();
                const leave = new AbortController();
                const onAbort = (): void => leave.abort();
                signal.addEventListener('abort', onAbort, { once: true });
                const crowd = new Set<Promise<void>>();
                let meter: Meter | null = null;
                let passed = true;
                try {
                    // Rien d'autre ne tourne ici (verrou) : un compte de ce serveur est un reste.
                    await sweepTestResidue(deps, by);
                    // Un seul hachage pour tous : un par compte pèserait sur la mesure sans rien représenter.
                    const password = randomBytes(24).toString('base64url');
                    const passwordHash = await hashPassword(password);
                    // Le relevé part avec la montée : la préparation n'est pas de la charge.
                    meter = createMeter({ wsSockets: deps.wsSockets, agentsOnline: deps.agentsOnline });
                    const userEnv: UserEnv = {
                        db: deps.db,
                        base,
                        host,
                        runToken,
                        passwordHash,
                        actions,
                        meter,
                        signal: leave.signal
                    };
                    live.phase = 'ramp';
                    const rampMs = settings.durationMin * 60_000;
                    const started = performance.now();
                    let launched = 0;
                    let nextSampleMs = live.bucketS * 1000;
                    while (!signal.aborted) {
                        const elapsed = performance.now() - started;
                        const target = Math.min(settings.users, Math.ceil((settings.users * elapsed) / rampMs));
                        while (launched < target && launched - meter.settled() < MAX_ARRIVING) {
                            launched++;
                            const user = simulateUser({ ...testIdentity(runId, launched), password }, userEnv);
                            crowd.add(user);
                            void user.finally(() => crowd.delete(user));
                        }
                        if (elapsed >= nextSampleMs) {
                            live.samples.push(meter.close(nextSampleMs / 1000));
                            live.features = meter.features();
                            live.arrivals = meter.arrivals();
                            Object.assign(live, analyze(live.samples));
                            const reason = saturation(live.samples);
                            if (reason) {
                                const { t, users } = live.samples[live.samples.length - 1];
                                live.saturatedAt = { t, users, reason };
                                break;
                            }
                            nextSampleMs += live.bucketS * 1000;
                        }
                        if (elapsed >= rampMs + HOLD_MS) break;
                        if (elapsed >= rampMs) live.phase = 'hold';
                        await delay(TICK_MS, undefined, { signal }).catch(() => undefined);
                    }
                } finally {
                    live.phase = 'cleanup';
                    leave.abort();
                    signal.removeEventListener('abort', onAbort);
                    await Promise.allSettled([...crowd]);
                    if (meter) {
                        meter.stop();
                        live.arrivals = meter.arrivals();
                    }
                    runGate.close();
                    const { failures } = await sweepTestResidue(deps, by).catch((e: Error) => ({
                        failures: [e.message]
                    }));
                    live.residueAfter = await countResidue(deps.db);
                    live.phase = 'done';
                    passed = failures.length === 0 && live.residueAfter === 0;
                    const peak = Math.max(0, ...live.samples.map((s) => s.users));
                    deps.audit.record({
                        source: 'system',
                        category: 'debug',
                        action: 'debug.loadRun',
                        level: passed ? 'info' : 'warning',
                        uid: launcher.id,
                        ip: '',
                        description: `Montée en charge : ${peak} utilisateur(s) au plus sur ${settings.users} visés, ${
                            live.saturatedAt ? `saturation à ${live.saturatedAt.users}` : 'sans saturation'
                        }, ${live.residueAfter} compte(s) restant(s)`,
                        metadata: { ...settings, peak, saturated: live.saturatedAt?.reason ?? null }
                    });
                }
                return passed;
            });
        }
    };
}

export type Load = ReturnType<typeof createLoad>;
