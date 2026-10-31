import { useState } from 'react';
import type { DebugLoadReport, DebugRun } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { NumberInput } from '@/Components/NumberInput';
import { formatClock, formatMs } from '../format';
import { useRun } from '../useRun';
import RunHistory, { RunStatusBadge } from './RunHistory';
import TimeChart, { type TimeMark, type TimeSeries } from './TimeChart';
import styles from '../Debug.module.css';

const DEFAULT_USERS = 100;
const DEFAULT_MINUTES = 5;
/** Les fonctionnalités nommées dans le graphe ; les suivantes se cumulent en « Autres ». */
const TOP_FEATURES = 6;
const FEATURE_COLORS = [
    'var(--palette-blue)',
    'var(--palette-orange)',
    'var(--palette-green)',
    'var(--palette-purple)',
    'var(--palette-pink)',
    'var(--palette-yellow)'
];

const PHASE: Record<DebugLoadReport['phase'], string> = {
    prepare: 'Préparation',
    ramp: 'Montée',
    hold: 'Palier au seuil',
    cleanup: 'Ménage',
    done: 'Terminé'
};

function loadOf(run: DebugRun | null): DebugLoadReport | null {
    return run?.report.kind === 'load' ? run.report : null;
}

const number = (v: number, digits = 0): string => v.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const maxOf = (values: readonly number[]): number | null => (values.length > 0 ? Math.max(...values) : null);

function Verdict({ report }: { report: DebugLoadReport }) {
    const { samples, arrivals } = report;
    const peakUsers = maxOf(samples.map((s) => s.users)) ?? 0;
    const peakRate = maxOf(samples.map((s) => s.commands / report.bucketS));
    const peakCpu = maxOf(samples.map((s) => s.cpuPct));
    const worstLoop = maxOf(samples.map((s) => s.loopP99));
    const peakRss = maxOf(samples.map((s) => s.rssMb));
    const facts: [string, string, string?][] = [
        ['Utilisateurs atteints', `${peakUsers} sur ${report.settings.users}`],
        ['Référence (p95)', formatMs(report.baselineP95), 'Les premiers seaux, à peu d’utilisateurs'],
        [
            'Dégradation',
            report.degradedAt ? `${report.degradedAt.users} utilisateurs` : 'Non atteinte',
            report.degradedAt
                ? `À ${formatClock(report.degradedAt.t)}, p95 nettement au-dessus de la référence`
                : 'Le p95 est resté proche de la référence'
        ],
        [
            'Saturation',
            report.saturatedAt ? `${report.saturatedAt.users} utilisateurs` : 'Non atteinte',
            report.saturatedAt ? `À ${formatClock(report.saturatedAt.t)} : ${report.saturatedAt.reason}` : undefined
        ],
        ['Débit maximal', peakRate === null ? '–' : `${number(peakRate, 1)} commandes/s`],
        ['Processeur (pic)', peakCpu === null ? '–' : `${number(peakCpu)} % d’un cœur`],
        ['Boucle (pire p99)', formatMs(worstLoop)],
        ['Mémoire (pic)', peakRss === null ? '–' : `${number(peakRss)} Mo`],
        [
            'Arrivée d’un utilisateur',
            `${formatMs(arrivals.p50)} / ${formatMs(arrivals.p95)}`,
            `Médiane / p95 sur ${arrivals.n}${arrivals.failed > 0 ? `, ${arrivals.failed} en échec` : ''}`
        ],
        [
            'Comptes restants',
            report.residueAfter === null ? '…' : String(report.residueAfter),
            'Après le ménage : zéro attendu'
        ]
    ];
    return (
        <div className={styles.facts}>
            {facts.map(([label, value, note]) => (
                <div key={label} className={styles.fact}>
                    <span className={styles.rowMeta}>{label}</span>
                    <span className={styles.factValue}>{value}</span>
                    {note && <span className={styles.rowMeta}>{note}</span>}
                </div>
            ))}
        </div>
    );
}

function Charts({ report }: { report: DebugLoadReport }) {
    const { samples, bucketS } = report;
    const t = samples.map((s) => s.t);
    const perSecond = (v: number): number => Math.round((v / bucketS) * 10) / 10;
    const marks: TimeMark[] = [
        ...(report.degradedAt ? [{ t: report.degradedAt.t, label: 'Dégradation', tone: 'warning' as const }] : []),
        ...(report.saturatedAt ? [{ t: report.saturatedAt.t, label: 'Saturation', tone: 'danger' as const }] : [])
    ];

    const named = report.features.slice(0, TOP_FEATURES);
    const others = new Set(report.features.slice(TOP_FEATURES).map((f) => f.key));
    const features: TimeSeries[] = named.map((f, i) => ({
        label: f.label,
        color: FEATURE_COLORS[i],
        values: samples.map((s) => perSecond(s.features[f.key]?.ms ?? 0))
    }));
    if (others.size > 0) {
        features.push({
            label: 'Autres',
            color: 'var(--text-muted)',
            values: samples.map((s) =>
                perSecond(Object.entries(s.features).reduce((sum, [key, f]) => sum + (others.has(key) ? f.ms : 0), 0))
            )
        });
    }

    const users: TimeSeries = {
        label: 'Utilisateurs',
        color: 'var(--text-muted)',
        values: samples.map((s) => s.users),
        right: true
    };
    return (
        <div className={styles.charts}>
            <TimeChart
                title='Temps de réponse des commandes'
                t={t}
                format={formatMs}
                formatRight={(v) => number(v)}
                marks={marks}
                series={[
                    { label: 'Médiane', color: 'var(--accent)', values: samples.map((s) => s.p50) },
                    { label: 'p95', color: 'var(--warning)', values: samples.map((s) => s.p95) },
                    users
                ]}
            />
            <TimeChart
                title='Débit et échecs, par seconde'
                t={t}
                format={(v) => number(v, 1)}
                marks={marks}
                series={[
                    { label: 'Commandes', color: 'var(--accent)', values: samples.map((s) => perSecond(s.commands)) },
                    { label: 'Refus', color: 'var(--warning)', values: samples.map((s) => perSecond(s.refused)) },
                    { label: 'Erreurs', color: 'var(--danger)', values: samples.map((s) => perSecond(s.errors)) }
                ]}
            />
            <TimeChart
                title='Le serveur'
                t={t}
                format={(v) => `${number(v)} %`}
                formatRight={formatMs}
                marks={marks}
                series={[
                    { label: 'Processeur (% d’un cœur)', color: 'var(--accent)', values: samples.map((s) => s.cpuPct) },
                    {
                        label: 'Retard de boucle (p99)',
                        color: 'var(--warning)',
                        values: samples.map((s) => s.loopP99),
                        right: true
                    }
                ]}
            />
            {features.length > 0 && (
                <TimeChart
                    title='Ce qui occupe le serveur (ms de traitement par seconde)'
                    t={t}
                    format={(v) => number(v)}
                    marks={marks}
                    series={features}
                    stacked
                />
            )}
        </div>
    );
}

function FeatureTable({ report }: { report: DebugLoadReport }) {
    const total = report.features.reduce((sum, f) => sum + f.ms, 0);
    if (report.features.length === 0) return null;
    return (
        <div className={styles.card}>
            <div className={styles.tableScroll}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Fonctionnalité</th>
                            <th>Appels</th>
                            <th title='Temps écoulé, attente de la base comprise'>Temps cumulé</th>
                            <th>Part</th>
                            <th>Moyenne</th>
                        </tr>
                    </thead>
                    <tbody>
                        {report.features.map((f) => (
                            <tr key={f.key}>
                                <td>{f.label}</td>
                                <td>{number(f.calls)}</td>
                                <td>{formatMs(f.ms)}</td>
                                <td>{total > 0 ? `${number((f.ms / total) * 100, 1)} %` : '–'}</td>
                                <td>{formatMs(f.calls > 0 ? f.ms / f.calls : null)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * Combien d'utilisateurs simultanés ce serveur tient, en ordre de grandeur :
 * des utilisateurs simulés ajoutés petit à petit, puis supprimés avec tout ce
 * qu'ils ont créé.
 */
export default function LoadSection({ activeRunId, production }: { activeRunId: number | null; production: boolean }) {
    const [users, setUsers] = useState<number | null>(DEFAULT_USERS);
    const [minutes, setMinutes] = useState<number | null>(DEFAULT_MINUTES);
    const { run, history, error, running, start, abort, show } = useRun('load', activeRunId);
    const report = loadOf(run);

    const launch = (): void => {
        void start(() =>
            ws.send('debug.loadStart', { users: users ?? DEFAULT_USERS, durationMin: minutes ?? DEFAULT_MINUTES })
        );
    };

    return (
        <>
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>Montée en charge</span>
                    <div className={styles.actions}>
                        {running ? (
                            <Button variant='secondary' icon='x' onClick={() => void abort()}>
                                Arrêter
                            </Button>
                        ) : (
                            <Button icon='play' onClick={launch}>
                                Lancer
                            </Button>
                        )}
                    </div>
                </div>
                <div className={`${styles.card} ${styles.formCard}`}>
                    <div className={styles.formRow}>
                        <label className={styles.field} htmlFor='debug-load-users'>
                            <span className={styles.fieldLabel}>Utilisateurs visés</span>
                            <NumberInput
                                id='debug-load-users'
                                value={users}
                                onChange={setUsers}
                                min={10}
                                max={500}
                                step={10}
                                disabled={running}
                            />
                        </label>
                        <label className={styles.field} htmlFor='debug-load-minutes'>
                            <span className={styles.fieldLabel}>Durée de la montée (minutes)</span>
                            <NumberInput
                                id='debug-load-minutes'
                                value={minutes}
                                onChange={setMinutes}
                                min={1}
                                max={30}
                                disabled={running}
                            />
                        </label>
                    </div>
                </div>
                <p className={styles.sectionHint}>
                    Des utilisateurs simulés arrivent petit à petit jusqu’au nombre visé, puis 30 s de palier. Chacun a
                    son compte jetable, se connecte, ouvre l’accueil puis une vue toutes les 5 s en moyenne, et écrit
                    parfois une note. La montée s’arrête d’elle-même si le serveur ne suit plus. À la fin, les comptes
                    et tout ce qu’ils ont créé sont supprimés. Les utilisateurs simulés tournent dans le processus du
                    serveur : le vrai seuil est un peu plus haut que celui mesuré.
                </p>
                {production && (
                    <div className={styles.warningBanner}>
                        <span className={styles.bannerText}>
                            En production, la charge est réelle : les personnes connectées la sentent, sur ce serveur
                            comme sur sa base.
                        </span>
                    </div>
                )}
                {error && <div className={styles.errorBanner}>{error}</div>}
            </section>

            {report && run && (
                <section className={styles.section}>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionLabel}>
                            {run.status === 'running' ? `En cours : ${PHASE[report.phase]}` : 'Résultat'}
                        </span>
                        <RunStatusBadge status={run.status} />
                    </div>
                    {!report.writes && (
                        <div className={styles.infoBanner}>
                            <span className={styles.bannerText}>
                                Notes n’est pas installé : les utilisateurs simulés n’ont fait que lire.
                            </span>
                        </div>
                    )}
                    <div className={styles.card}>
                        <Verdict report={report} />
                    </div>
                    {report.samples.length > 0 && <Charts report={report} />}
                    <span className={styles.sectionLabel}>Par fonctionnalité, sur tout l’essai</span>
                    <p className={styles.sectionHint}>
                        Le temps que chaque fonctionnalité a passé à servir, vrais utilisateurs et tâches de fond
                        compris : du temps écoulé, attente de la base comprise, pas du processeur.
                    </p>
                    <FeatureTable report={report} />
                </section>
            )}

            <RunHistory
                runs={history}
                selectedId={run?.id ?? null}
                onSelect={show}
                summary={(r) => {
                    const load = loadOf(r);
                    if (!load) return '';
                    const saturated = load.saturatedAt ? `, saturation à ${load.saturatedAt.users}` : '';
                    return `${load.settings.users} utilisateurs sur ${load.settings.durationMin} min${saturated}`;
                }}
            />
        </>
    );
}
