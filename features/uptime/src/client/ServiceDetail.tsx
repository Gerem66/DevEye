import { useEffect, useMemo, useState } from 'react';
import { Button, FeatureSettingsButton, StatusBadge } from 'deveye-sdk-client';
import type {
    UptimeCheck,
    UptimeIncident,
    UptimePoint,
    UptimeRange,
    UptimeResolution,
    UptimeService
} from '../contracts/domain';

import { api } from './api';
import { formatAgo, formatDuration, formatMoment, formatMs, formatRatio, rangeWindow, RANGES } from './format';
import MeasuresBrowser from './MeasuresBrowser';
import Pane from './Pane';
import StatusBars from './StatusBars';
import UptimeChart from './UptimeChart';
import styles from './style.module.css';

/** Measures previewed inline; the full record lives in {@link MeasuresBrowser}. */
const CHECKS_PREVIEW = 8;
/** Outages listed under the chart. */
const INCIDENTS_MAX = 20;

interface ServiceDetailProps {
    service: UptimeService;
    onBack: () => void;
    onEdit: () => void;
    onCheckNow: () => void;
}

/**
 * One service in full: availability curve over a chosen window, outage log and
 * the raw ping journal.
 *
 * The three panels load independently (a slow journal never holds the chart
 * back), and only the chart re-queries when the range changes.
 */
export function ServiceDetail({ service, onBack, onEdit, onCheckNow }: ServiceDetailProps) {
    const [range, setRange] = useState<UptimeRange>('24h');
    const [points, setPoints] = useState<UptimePoint[]>([]);
    const [resolution, setResolution] = useState<UptimeResolution>('raw');
    const [incidents, setIncidents] = useState<UptimeIncident[]>([]);
    const [checks, setChecks] = useState<UptimeCheck[]>([]);
    // One busy flag per block: each reloads on its own and dims in place rather
    // than collapsing the layout (see Pane).
    const [busyChart, setBusyChart] = useState(true);
    const [busyIncidents, setBusyIncidents] = useState(true);
    const [busyChecks, setBusyChecks] = useState(true);
    const [journalOpen, setJournalOpen] = useState(false);
    // A failed refresh must never masquerade as "there is nothing here": the last
    // good data stays on screen and this says so. Cleared when a cycle starts.
    const [staleError, setStaleError] = useState<string | null>(null);

    const id = service.id;
    // `lastCheckedAt` moves on every probe, so threading it through the deps is
    // what makes "Tester maintenant" and the background ticks refresh the panels.
    const stamp = service.lastCheckedAt;

    useEffect(() => {
        let cancelled = false;
        setBusyChart(true);
        // Opens the refresh cycle the three blocks share.
        setStaleError(null);
        api.send('uptime.history', { id, range })
            .then((res) => {
                if (cancelled) return;
                setPoints(res.points);
                setResolution(res.resolution);
            })
            .catch(() => {
                if (!cancelled) setStaleError('Historique indisponible.');
            })
            .finally(() => {
                if (!cancelled) setBusyChart(false);
            });
        return () => {
            cancelled = true;
        };
    }, [id, range, stamp]);

    useEffect(() => {
        let cancelled = false;
        setBusyIncidents(true);
        api.send('uptime.incidents', { id, limit: INCIDENTS_MAX })
            .then((res) => {
                if (!cancelled) setIncidents(res.incidents);
            })
            .catch(() => {
                if (!cancelled) setStaleError('Incidents indisponibles.');
            })
            .finally(() => {
                if (!cancelled) setBusyIncidents(false);
            });
        return () => {
            cancelled = true;
        };
    }, [id, stamp]);

    useEffect(() => {
        let cancelled = false;
        setBusyChecks(true);
        api.send('uptime.checks', { id, limit: CHECKS_PREVIEW, filter: { since: null, failuresOnly: false } })
            .then((res) => {
                if (!cancelled) setChecks(res.checks);
            })
            .catch(() => {
                if (!cancelled) setStaleError('Mesures indisponibles.');
            })
            .finally(() => {
                if (!cancelled) setBusyChecks(false);
            });
        return () => {
            cancelled = true;
        };
    }, [id, stamp]);

    // The window both charts are drawn on: the selected duration, so a
    // freshly-added service shows its samples against the period it lacks.
    const axis = useMemo(() => rangeWindow(range, points), [range, points]);

    const totalChecks = points.reduce((sum, p) => sum + p.checks, 0);
    const totalUp = points.reduce((sum, p) => sum + p.upChecks, 0);
    const timed = points.filter((p) => p.avgMs !== null);
    const avgMs =
        timed.length > 0 ? Math.round(timed.reduce((sum, p) => sum + (p.avgMs ?? 0), 0) / timed.length) : null;
    const minMs = timed.length > 0 ? Math.min(...timed.map((p) => p.minMs ?? Infinity)) : null;
    const maxMs = timed.length > 0 ? Math.max(...timed.map((p) => p.maxMs ?? 0)) : null;

    if (journalOpen) {
        return <MeasuresBrowser service={service} onBack={() => setJournalOpen(false)} />;
    }

    return (
        <div className={styles.detail}>
            <div className={styles.detailHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Services
                </Button>
                <div className={styles.detailTitle}>
                    <h3 className={styles.detailName}>{service.name}</h3>
                    <a className={styles.detailUrl} href={service.url} target='_blank' rel='noreferrer'>
                        {service.url}
                    </a>
                </div>
                <div className={styles.detailActions}>
                    <Button variant='secondary' icon='refresh' onClick={onCheckNow}>
                        Tester
                    </Button>
                    <Button variant='secondary' icon='edit' onClick={onEdit}>
                        Modifier
                    </Button>
                    <FeatureSettingsButton
                        scope={{
                            kind: 'item',
                            feature: 'uptime',
                            itemId: service.id,
                            itemLabel: service.name
                        }}
                    />
                </div>
            </div>

            {staleError && <p className={styles.error}>{staleError}</p>}

            <div className={styles.ranges}>
                {RANGES.map((r) => (
                    <button
                        key={r.value}
                        type='button'
                        className={`${styles.rangeBtn} ${range === r.value ? styles.rangeActive : ''}`}
                        onClick={() => setRange(r.value)}
                    >
                        {r.label}
                    </button>
                ))}
            </div>

            <Pane busy={busyChart}>
                {/* State first (where were the outages?), latency second: both
                    laid out on the same window so the columns match. */}
                <StatusBars points={points} from={axis.from} to={axis.to} resolution={resolution} />
                <UptimeChart points={points} from={axis.from} to={axis.to} resolution={resolution} />

                <div className={styles.summary}>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>
                            {formatRatio(totalChecks > 0 ? totalUp / totalChecks : null)}
                        </span>
                        <span className={styles.summaryLabel}>disponibilité</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(avgMs)}</span>
                        <span className={styles.summaryLabel}>latence moyenne</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(minMs === Infinity ? null : minMs)}</span>
                        <span className={styles.summaryLabel}>minimum</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{formatMs(maxMs)}</span>
                        <span className={styles.summaryLabel}>maximum</span>
                    </div>
                    <div className={styles.summaryItem}>
                        <span className={styles.summaryValue}>{totalChecks.toLocaleString('fr-FR')}</span>
                        <span className={styles.summaryLabel}>mesures</span>
                    </div>
                </div>
            </Pane>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Incidents</h4>
                <Pane busy={busyIncidents}>
                    {incidents.length === 0 ? (
                        <p className={styles.empty}>Aucune panne enregistrée.</p>
                    ) : (
                        <ul className={styles.list}>
                            {incidents.map((incident) => (
                                <li key={incident.id} className={styles.incident}>
                                    <StatusBadge tone={incident.endedAt === null ? 'danger' : 'neutral'}>
                                        {incident.endedAt === null
                                            ? 'en cours'
                                            : formatDuration(incident.endedAt - incident.startedAt)}
                                    </StatusBadge>
                                    <span className={styles.incidentWhen}>{formatMoment(incident.startedAt)}</span>
                                    <span className={styles.incidentError}>{incident.error ?? '—'}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Pane>
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Journal des mesures</h4>
                <Pane busy={busyChecks}>
                    {checks.length === 0 ? (
                        <p className={styles.empty}>Aucune mesure enregistrée.</p>
                    ) : (
                        <ul className={styles.list}>
                            {checks.map((check, i) => (
                                <li key={`${check.at}-${i}`} className={styles.checkRow}>
                                    <span
                                        className={`${styles.dot} ${check.up ? styles.dotUp : styles.dotDown}`}
                                        aria-hidden='true'
                                    />
                                    <span className={styles.checkWhen}>{formatMoment(check.at)}</span>
                                    <span className={styles.checkStatus}>{check.httpStatus ?? '—'}</span>
                                    <span className={styles.checkMs}>{formatMs(check.responseMs)}</span>
                                    <span className={styles.checkError}>{check.error ?? ''}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Pane>
                <Button variant='ghost' icon='list' onClick={() => setJournalOpen(true)}>
                    Voir toutes les mesures
                </Button>
            </section>

            <p className={styles.detailFoot}>
                Dernière mesure {formatAgo(service.lastCheckedAt)} · conservation détaillée{' '}
                {service.retentionDays === null ? 'illimitée' : `${service.retentionDays} jours`} · résumé journalier
                conservé indéfiniment.
            </p>
        </div>
    );
}

export default ServiceDetail;
