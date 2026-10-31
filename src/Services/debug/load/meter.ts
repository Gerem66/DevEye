import type { DebugLoadFeature, DebugLoadReport, DebugLoadSample } from '@deveye/types';

import { moduleManifest } from '@/features/_sdk/register';
import { featureLoad, type FeatureTime } from '@/Services/featureLoad';
import { systemWatch } from '../bench/system';
import { summarize } from '../stats';

/** `refused` : le serveur a répondu non (droit, quota) ; `error` : il n'a pas su répondre. */
export type Outcome = 'ok' | 'refused' | 'error';

const round = (v: number): number => Math.round(v * 10) / 10;

const labelOf = (key: string): string => moduleManifest(key)?.label ?? `Socle (${key})`;

/**
 * Le relevé de la montée en charge, seau par seau : ce que vivent les
 * utilisateurs simulés (durées, refus, erreurs, arrivées) et ce que fait le
 * serveur pendant ce temps (CPU, boucle, mémoire, temps par fonctionnalité).
 */
export function createMeter(counts: { wsSockets(): number; agentsOnline(): number }) {
    const features = featureLoad.watch();
    const totals = new Map<string, FeatureTime>();
    const arrivalMs: number[] = [];
    let arrivalFailures = 0;
    let connected = 0;

    const open = () => ({
        latencies: [] as number[],
        commands: 0,
        refused: 0,
        errors: 0,
        arrivals: 0,
        system: systemWatch(counts)
    });
    let bucket = open();

    return {
        /** Une commande d'un utilisateur ; les durées des erreurs (délai, socket perdue) ne disent rien du serveur. */
        command(ms: number, outcome: Outcome): void {
            bucket.commands++;
            if (outcome === 'error') {
                bucket.errors++;
                return;
            }
            bucket.latencies.push(ms);
            if (outcome === 'refused') bucket.refused++;
        },
        arrived(ms: number): void {
            arrivalMs.push(ms);
            bucket.arrivals++;
            connected++;
        },
        arrivalFailed(): void {
            arrivalFailures++;
            bucket.errors++;
        },
        /** `lost` : la socket est tombée avant la fin de la montée. */
        left(lost: boolean): void {
            connected--;
            if (lost) bucket.errors++;
        },
        /** Les arrivées terminées, réussies ou non. */
        settled: (): number => arrivalMs.length + arrivalFailures,

        /** Clôt le seau en cours et en ouvre un autre ; `t` en secondes depuis le début. */
        close(t: number): DebugLoadSample {
            const spent: Record<string, FeatureTime> = {};
            for (const [key, f] of features.drain()) {
                spent[key] = { calls: f.calls, ms: round(f.ms) };
                const total = totals.get(key);
                if (total) {
                    total.calls += f.calls;
                    total.ms += f.ms;
                } else totals.set(key, { ...f });
            }
            const system = bucket.system.stop();
            const summary = summarize(bucket.latencies);
            const sample: DebugLoadSample = {
                t,
                users: connected,
                sockets: system.wsSockets,
                commands: bucket.commands,
                refused: bucket.refused,
                errors: bucket.errors,
                p50: summary?.p50 ?? null,
                p95: summary?.p95 ?? null,
                max: summary?.max ?? null,
                arrivals: bucket.arrivals,
                cpuPct: system.cpuPct,
                loopP99: system.loop.p99,
                rssMb: system.rssMb,
                features: spent
            };
            bucket = open();
            return sample;
        },

        features(): DebugLoadFeature[] {
            return [...totals]
                .map(([key, f]) => ({ key, label: labelOf(key), calls: f.calls, ms: round(f.ms) }))
                .sort((a, b) => b.ms - a.ms);
        },

        arrivals(): DebugLoadReport['arrivals'] {
            const summary = summarize(arrivalMs);
            return {
                n: arrivalMs.length,
                failed: arrivalFailures,
                p50: summary?.p50 ?? null,
                p95: summary?.p95 ?? null
            };
        },

        stop(): void {
            bucket.system.stop();
            features.stop();
        }
    };
}

export type Meter = ReturnType<typeof createMeter>;
