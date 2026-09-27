import type { DebugBenchProfile, DebugBenchReport, DebugProbe, DebugProbeResult } from '@deveye/types';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { Mailer } from '@/Services/mailer';
import type { Launcher, RunRegistry } from '../runs';
import { summarize } from '../stats';
import { CLIENT_PROBES, PROBES, type Probe, type ProbeContext } from './probes';
import { systemWatch } from './system';

/** Le plafond de toute une mesure : elle doit pouvoir tourner en production sans qu'on la sente. */
const TOTAL_CAP_MS = 30_000;

export interface BenchDeps {
    db: Database;
    crypt: Encryption;
    mailer: Mailer;
    origin: string;
    runs: RunRegistry;
    wsSockets(): number;
    agentsOnline(): number;
}

function resultOf(
    probe: { id: string; label: string },
    samples: readonly number[],
    errors: number,
    skipped: string | null = null
): DebugProbeResult {
    const summary = summarize(samples);
    return {
        id: probe.id,
        label: probe.label,
        n: summary?.n ?? 0,
        p50: summary?.p50 ?? null,
        p95: summary?.p95 ?? null,
        max: summary?.max ?? null,
        mean: summary?.mean ?? null,
        errors,
        skipped
    };
}

/** Une sonde après l'autre, jamais en parallèle : chaque chiffre dit ce que coûte une opération seule, à cet instant. */
async function measure(probe: Probe, ctx: ProbeContext, profile: DebugBenchProfile, deadline: number) {
    const samples: number[] = [];
    let errors = 0;
    const until = Math.min(deadline, performance.now() + probe.capMs);
    for (let i = 0; i < probe.iterations[profile] && !ctx.signal.aborted && performance.now() < until; i++) {
        const started = performance.now();
        try {
            const own = await probe.once(ctx);
            samples.push(typeof own === 'number' ? own : performance.now() - started);
        } catch {
            errors++;
        }
    }
    return { samples, errors };
}

export function createBench(deps: BenchDeps) {
    return {
        catalog(): DebugProbe[] {
            return [
                ...PROBES.map((p) => ({ id: p.id, label: p.label, description: p.description, clientSide: false })),
                ...CLIENT_PROBES.map((p) => ({ ...p }))
            ];
        },

        start(
            launcher: Launcher,
            profile: DebugBenchProfile,
            client: { wsRttMs: readonly number[]; httpRttMs: readonly number[] }
        ): Promise<number> {
            const clientSamples: Record<(typeof CLIENT_PROBES)[number]['id'], readonly number[]> = {
                'ws.command': client.wsRttMs,
                'http.browser': client.httpRttMs
            };
            const report: DebugBenchReport = {
                kind: 'bench',
                profile,
                probes: [
                    ...PROBES.map((p) => resultOf(p, [], 0)),
                    ...CLIENT_PROBES.map((p) =>
                        resultOf(p, clientSamples[p.id], 0, clientSamples[p.id].length === 0 ? 'Non mesurée' : null)
                    )
                ],
                context: null
            };
            return deps.runs.start(launcher, report, async ({ signal, report: live }) => {
                const watch = systemWatch({ wsSockets: deps.wsSockets, agentsOnline: deps.agentsOnline });
                const deadline = performance.now() + TOTAL_CAP_MS;
                const ctx: ProbeContext = {
                    db: deps.db,
                    crypt: deps.crypt,
                    mailer: deps.mailer,
                    origin: deps.origin,
                    userId: launcher.id,
                    signal
                };
                let passed = true;
                try {
                    for (const [i, probe] of PROBES.entries()) {
                        if (signal.aborted) break;
                        const skipped =
                            probe.skip?.(ctx) ??
                            (performance.now() > deadline ? 'Temps total de la mesure écoulé' : null);
                        if (skipped) {
                            live.probes[i] = resultOf(probe, [], 0, skipped);
                            continue;
                        }
                        const { samples, errors } = await measure(probe, ctx, profile, deadline);
                        live.probes[i] = resultOf(probe, samples, errors);
                        if (errors > 0) passed = false;
                    }
                } finally {
                    live.context = watch.stop();
                }
                return passed;
            });
        }
    };
}

export type Bench = ReturnType<typeof createBench>;
