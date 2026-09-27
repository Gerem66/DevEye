import { useEffect, useMemo, useState } from 'react';
import type { DebugBenchContext, DebugBenchReport, DebugProbe, DebugRun } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import SegmentedControl from '@/Components/SegmentedControl';
import { formatDelta, formatMs, median, relativeDelta } from '../format';
import { useRun } from '../useRun';
import RunHistory, { RunStatusBadge } from './RunHistory';
import Sparkline from './Sparkline';
import styles from '../Debug.module.css';

type Profile = DebugBenchReport['profile'];

const CLIENT_ITERATIONS: Record<Profile, { ws: number; http: number }> = {
    quick: { ws: 10, http: 5 },
    full: { ws: 30, http: 15 }
};

/** Plus lent de 25 % que la référence : à regarder. Plus rapide de 10 % : mieux. */
const WORSE = 25;
const BETTER = -10;

async function timeEach(n: number, fn: () => Promise<unknown>): Promise<number[]> {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
        const started = performance.now();
        try {
            await fn();
            samples.push(Math.round((performance.now() - started) * 10) / 10);
        } catch {
            // Un échec ne compte pas comme une durée.
        }
    }
    return samples;
}

function benchOf(run: DebugRun | null): DebugBenchReport | null {
    return run?.report.kind === 'bench' ? run.report : null;
}

function DeltaCell({ pct }: { pct: number | null }) {
    const tone = pct === null ? '' : pct >= WORSE ? styles.worse : pct <= BETTER ? styles.better : styles.muted;
    return <td className={tone}>{formatDelta(pct)}</td>;
}

function ContextFacts({ context }: { context: DebugBenchContext }) {
    const facts: [string, string][] = [
        ['Boucle (p50 / p99)', `${formatMs(context.loop.p50)} / ${formatMs(context.loop.p99)}`],
        ['Processeur', `${context.cpuPct.toLocaleString('fr-FR')} % d’un cœur`],
        ['Mémoire', `${Math.round(context.rssMb)} Mo (tas ${Math.round(context.heapMb)} Mo)`],
        ['Charge (1 / 5 / 15 min)', context.loadavg.map((v) => v.toLocaleString('fr-FR')).join(' / ')],
        ['Navigateurs connectés', String(context.wsSockets)],
        ['Agents en ligne', String(context.agentsOnline)],
        ['Démarré depuis', formatMs(context.uptimeS * 1000)],
        ['Version', context.version]
    ];
    return (
        <div className={styles.facts}>
            {facts.map(([label, value]) => (
                <div key={label} className={styles.fact}>
                    <span className={styles.rowMeta}>{label}</span>
                    <span className={styles.factValue}>{value}</span>
                </div>
            ))}
        </div>
    );
}

/**
 * Ce que coûte chaque opération à cet instant, pour comparer d'une charge à
 * l'autre. Sans danger en production : une sonde après l'autre, en petit
 * nombre, 30 s au plus.
 */
export default function BenchSection({ activeRunId }: { activeRunId: number | null }) {
    const [probes, setProbes] = useState<DebugProbe[]>([]);
    const [profile, setProfile] = useState<Profile>('quick');
    const [measuring, setMeasuring] = useState(false);
    const { run, history, error, running, start, abort, show } = useRun('bench', activeRunId);

    useEffect(() => {
        ws.send('debug.benchCatalog', {})
            .then(({ probes: list }) => setProbes(list))
            .catch(() => setProbes([]));
    }, []);

    const report = benchOf(run);
    // Les mesures du même profil, antérieures à celle affichée, de la plus récente à la plus ancienne.
    const earlier = useMemo(
        () =>
            history.filter((r) => {
                const b = benchOf(r);
                return (
                    b && b.profile === report?.profile && r.status !== 'running' && run && r.startedAt < run.startedAt
                );
            }),
        [history, report?.profile, run]
    );

    const launch = (): void => {
        void start(async () => {
            setMeasuring(true);
            try {
                const n = CLIENT_ITERATIONS[profile];
                const wsRttMs = await timeEach(n.ws, () => ws.send('debug.ping', {}));
                const httpRttMs = await timeEach(n.http, async () => {
                    const response = await fetch('/api/health', { cache: 'no-store' });
                    if (!response.ok) throw new WsError('internal', `HTTP ${response.status}`);
                });
                return await ws.send('debug.benchStart', { profile, client: { wsRttMs, httpRttMs } });
            } finally {
                setMeasuring(false);
            }
        });
    };

    const p50Of = (r: DebugRun, probeId: string): number | null =>
        benchOf(r)?.probes.find((p) => p.id === probeId)?.p50 ?? null;

    return (
        <>
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>Mesures</span>
                    <div className={styles.actions}>
                        <SegmentedControl
                            value={profile}
                            onChange={setProfile}
                            disabled={running}
                            aria-label='Profil de mesure'
                            options={[
                                { value: 'quick', label: 'Rapide', title: 'Une dizaine d’itérations par sonde' },
                                { value: 'full', label: 'Complète', title: 'Jusqu’à trente itérations par sonde' }
                            ]}
                        />
                        {running ? (
                            <Button variant='secondary' icon='x' onClick={() => void abort()} disabled={measuring}>
                                Arrêter
                            </Button>
                        ) : (
                            <Button icon='play' onClick={launch}>
                                Mesurer
                            </Button>
                        )}
                    </div>
                </div>
                <p className={styles.sectionHint}>
                    Chaque sonde tourne seule, quelques fois, et s’arrête à son plafond de temps : la mesure se lance en
                    production sans peser sur elle. Comparez deux mesures prises à des moments de charge différents.
                </p>
                {error && <div className={styles.errorBanner}>{error}</div>}
            </section>

            {report && run && (
                <section className={styles.section}>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionLabel}>
                            {run.status === 'running' ? 'Mesure en cours' : 'Résultat'}
                        </span>
                        <RunStatusBadge status={run.status} />
                    </div>
                    <div className={styles.card}>
                        <div className={styles.tableScroll}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Sonde</th>
                                        <th>Médiane</th>
                                        <th>p95</th>
                                        <th>Max</th>
                                        <th title='Itérations, et échecs'>n</th>
                                        <th title='Médiane comparée à la mesure précédente du même profil'>
                                            Précédente
                                        </th>
                                        <th title='Médiane comparée à la médiane des 10 mesures précédentes'>
                                            10 dernières
                                        </th>
                                        <th>Tendance</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.probes.map((p) => {
                                        const previous = earlier[0] ? p50Of(earlier[0], p.id) : null;
                                        const reference = median(
                                            earlier
                                                .slice(0, 10)
                                                .map((r) => p50Of(r, p.id))
                                                .filter((v): v is number => v !== null)
                                        );
                                        const trend = [...earlier.slice(0, 19)]
                                            .reverse()
                                            .map((r) => p50Of(r, p.id))
                                            .concat(p.p50)
                                            .filter((v): v is number => v !== null);
                                        const description = probes.find((d) => d.id === p.id)?.description;
                                        return (
                                            <tr key={p.id}>
                                                <td title={description}>
                                                    {p.label}
                                                    {p.skipped && <div className={styles.rowMeta}>{p.skipped}</div>}
                                                </td>
                                                <td>{formatMs(p.p50)}</td>
                                                <td>{formatMs(p.p95)}</td>
                                                <td>{formatMs(p.max)}</td>
                                                <td className={p.errors > 0 ? styles.failed : undefined}>
                                                    {p.n}
                                                    {p.errors > 0 ? ` (${p.errors} en échec)` : ''}
                                                </td>
                                                <DeltaCell pct={relativeDelta(p.p50, previous)} />
                                                <DeltaCell pct={relativeDelta(p.p50, reference)} />
                                                <td>
                                                    <Sparkline values={trend} label={`Tendance de ${p.label}`} />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    {report.context && (
                        <>
                            <span className={styles.sectionLabel}>Le serveur pendant la mesure</span>
                            <div className={styles.card}>
                                <ContextFacts context={report.context} />
                            </div>
                        </>
                    )}
                </section>
            )}

            <RunHistory
                runs={history}
                selectedId={run?.id ?? null}
                onSelect={show}
                summary={(r) => (benchOf(r)?.profile === 'full' ? 'Mesure complète' : 'Mesure rapide')}
            />
        </>
    );
}
