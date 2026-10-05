import { useCallback, useEffect, useState } from 'react';
import type { AdminExternalServices, ExternalService, ExternalServiceMeter, ExternalServiceState } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import LoadingVeil from '@/Components/LoadingVeil';
import StatusBadge, { type BadgeTone } from '@/Components/StatusBadge/StatusBadge';
import { formatBytesFr } from '@/format';
import { requestOpenView } from '@/stores/viewRequest';
import styles from './ExternalServices.module.css';

const STATE_BADGE: Record<ExternalServiceState, { tone: BadgeTone; label: string }> = {
    ok: { tone: 'success', label: 'Opérationnel' },
    degraded: { tone: 'warning', label: 'Dégradé' },
    down: { tone: 'danger', label: 'En panne' },
    inactive: { tone: 'neutral', label: 'Inactif' }
};

/** Le « il y a » du pied de page avance sans relancer de vérification. */
const CLOCK_MS = 30_000;

function ago(at: number, now: number): string {
    const minutes = Math.round((now - at) / 60_000);
    if (minutes < 1) return 'à l’instant';
    return minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.round(minutes / 60)} h`;
}

const amount = (meter: ExternalServiceMeter, value: number): string =>
    meter.unit === 'bytes' ? formatBytesFr(value) : value.toLocaleString('fr-FR');

function Meter({ meter }: { meter: ExternalServiceMeter }) {
    const ratio = Math.min(1, meter.used / meter.limit);
    const level = ratio >= 0.95 ? styles.meterDanger : ratio >= 0.8 ? styles.meterWarning : '';
    const percent = (meter.used / meter.limit) * 100;
    return (
        <div className={styles.meter}>
            <div className={styles.meterHead}>
                <span>{meter.label}</span>
                <span className={styles.meterValue}>
                    {amount(meter, meter.used)} sur {amount(meter, meter.limit)} (
                    {percent < 1 && percent > 0 ? '< 1' : Math.round(percent)} %)
                </span>
            </div>
            <div
                className={styles.meterTrack}
                role='meter'
                aria-label={meter.label}
                aria-valuemin={0}
                aria-valuemax={meter.limit}
                aria-valuenow={meter.used}
            >
                <div className={`${styles.meterFill} ${level}`} style={{ width: `${ratio * 100}%` }} />
            </div>
            {meter.note && <span className={styles.note}>{meter.note}</span>}
        </div>
    );
}

function ServiceCard({ service }: { service: ExternalService }) {
    const badge = STATE_BADGE[service.state];
    return (
        <article className={`${styles.card} ${service.state === 'inactive' ? styles.inactive : ''}`}>
            <header className={styles.cardHead}>
                <div className={styles.cardTitle}>
                    <h3 className={styles.name}>{service.name}</h3>
                    {service.provider && <span className={styles.provider}>{service.provider}</span>}
                </div>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </header>
            {service.summary && <p className={styles.summary}>{service.summary}</p>}
            {service.facts && service.facts.length > 0 && (
                <dl className={styles.facts}>
                    {service.facts.map((fact) => (
                        <div key={fact.label} className={styles.fact}>
                            <dt>{fact.label}</dt>
                            <dd className={fact.tone ? styles[fact.tone] : undefined}>{fact.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {service.meters?.map((meter) => (
                <Meter key={meter.label} meter={meter} />
            ))}
        </article>
    );
}

function seatsText(seat: AdminExternalServices['seats']['free']): string {
    const present = `${seat.present} connecté${seat.present > 1 ? 's' : ''}`;
    const cap = seat.cap === null ? 'sans limite' : `sur ${seat.cap} places`;
    return seat.waiting > 0 ? `${present} ${cap}, ${seat.waiting} en attente` : `${present} ${cap}`;
}

/**
 * Page « Services externes » : chaque dépendance de l'instance (paiement,
 * stockage, API tierces), son état et ses chiffres, l'hôte d'abord puis
 * chaque module. Réservée à l'administrateur global.
 */
export default function FeatureExternalServices() {
    const [state, setState] = useState<AdminExternalServices | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async (refresh: boolean) => {
        setBusy(true);
        setError(null);
        try {
            setState(await ws.send('admin.externalServices', { refresh }));
            setNow(Date.now());
        } catch (e) {
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de lire l’état des services.'
            );
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        void load(false);
    }, [load]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
        return () => clearInterval(timer);
    }, []);

    const counts = (state?.services ?? []).reduce<Partial<Record<ExternalServiceState, number>>>((acc, s) => {
        acc[s.state] = (acc[s.state] ?? 0) + 1;
        return acc;
    }, {});

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerText}>
                    <h2 className={styles.title}>Services externes</h2>
                    <p className={styles.subtitle}>
                        Ce dont dépend cette instance, son état, et ce qu’il en coûte.
                        {state && ` Vérifié ${ago(state.checkedAt, now)}.`}
                    </p>
                </div>
                <Button variant='secondary' icon='refresh' disabled={busy} onClick={() => void load(true)}>
                    Revérifier
                </Button>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            {!state ? (
                busy && (
                    <div className={styles.body}>
                        <LoadingVeil label='Vérification des services…' />
                    </div>
                )
            ) : (
                <div className={styles.body}>
                    <div className={`${styles.sections} ${busy ? styles.dimmed : ''}`}>
                        {Boolean(counts.down || counts.degraded) && (
                            <div className={styles.tally}>
                                {counts.down ? <StatusBadge tone='danger'>{counts.down} en panne</StatusBadge> : null}
                                {counts.degraded ? (
                                    <StatusBadge tone='warning'>
                                        {counts.degraded} dégradé{counts.degraded > 1 ? 's' : ''}
                                    </StatusBadge>
                                ) : null}
                            </div>
                        )}

                        <section className={styles.section}>
                            <span className={styles.sectionLabel}>Services</span>
                            <div className={styles.grid}>
                                {state.services.map((service) => (
                                    <ServiceCard key={service.id} service={service} />
                                ))}
                            </div>
                        </section>

                        <section className={styles.section}>
                            <span className={styles.sectionLabel}>Places sur ce serveur</span>
                            <div className={styles.seats}>
                                <div className={styles.seatRow}>
                                    <span className={styles.seatTitle}>Abonnés</span>
                                    <span className={styles.seatMeta}>{seatsText(state.seats.paid)}</span>
                                </div>
                                <div className={styles.seatRow}>
                                    <span className={styles.seatTitle}>Comptes gratuits</span>
                                    <span className={styles.seatMeta}>{seatsText(state.seats.free)}</span>
                                </div>
                                <Button
                                    variant='ghost'
                                    icon='arrow'
                                    className={styles.seatLink}
                                    onClick={() => requestOpenView('maintenance')}
                                >
                                    Régler dans Accès et maintenance
                                </Button>
                            </div>
                            <p className={styles.sectionHint}>
                                Aucun plafond ne borne le nombre d’abonnements : seules les places simultanées limitent
                                qui est servi à la fois.
                            </p>
                        </section>
                    </div>
                    {busy && <LoadingVeil align='top' delayed label='Vérification des services…' />}
                </div>
            )}
        </div>
    );
}
