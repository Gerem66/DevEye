import { loadavg } from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { DebugBenchContext } from '@deveye/types';

import { appVersion } from '@/version';

const MB = 1024 * 1024;
const RESOLUTION_MS = 10;
/** L'histogramme compte la période d'échantillonnage dans chaque mesure : seul le dépassement est un retard. */
const ms = (ns: number): number => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 10) / 10);

/** Le retard de la boucle d'événements : ce qui fait attendre toutes les requêtes à la fois. */
export function loopWatch(): { stop(): { p50: number; p99: number; max: number; count: number } } {
    const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    return {
        stop() {
            histogram.disable();
            return {
                p50: ms(histogram.percentile(50)),
                p99: ms(histogram.percentile(99)),
                max: ms(histogram.max),
                count: histogram.count
            };
        }
    };
}

/** Le relevé d'une période : CPU du processus en pour cent d'un cœur, mémoire, charge et connexions. */
export function systemWatch(counts: { wsSockets(): number; agentsOnline(): number }) {
    const loop = loopWatch();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    return {
        stop(): DebugBenchContext {
            const cpu = process.cpuUsage(cpuStart);
            const wallMs = Math.max(1, performance.now() - wallStart);
            const memory = process.memoryUsage();
            const [one, five, fifteen] = loadavg();
            const round = (v: number, digits = 1): number => Math.round(v * 10 ** digits) / 10 ** digits;
            const { p50, p99, max } = loop.stop();
            return {
                loop: { p50, p99, max },
                rssMb: round(memory.rss / MB),
                heapMb: round(memory.heapUsed / MB),
                cpuPct: round(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
                loadavg: [round(one, 2), round(five, 2), round(fifteen, 2)],
                wsSockets: counts.wsSockets(),
                agentsOnline: counts.agentsOnline(),
                uptimeS: Math.round(process.uptime()),
                version: appVersion()
            };
        }
    };
}
