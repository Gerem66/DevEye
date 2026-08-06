import { StatusBadge } from '@/Components/StatusBadge';

import { formatAgo, formatDuration, formatMs, formatRatio } from './format';
import styles from './style.module.css';

import type { UptimeService } from 'deveye-types';
import { useLiveOutline } from '@/live/useLiveOutline';

interface ServiceCardProps {
    service: UptimeService;
    onOpen: () => void;
    onEdit: () => void;
    onToggle: () => void;
    onCheckNow: () => void;
    /** A probe or a toggle is in flight for this service. */
    busy: boolean;
    /** Card being dragged right now — dimmed, never restyled otherwise. */
    dragging: boolean;
    onDragPointerDown: (e: React.PointerEvent) => void;
}

/** Badge tone + label for a service's live state. */
function statusBadge(service: UptimeService): { tone: 'online' | 'danger' | 'neutral'; label: string } {
    if (!service.enabled) return { tone: 'neutral', label: 'en pause' };
    if (service.status === 'up') return { tone: 'online', label: 'en ligne' };
    if (service.status === 'down') {
        const since = service.downSince;
        const forHow = since === null ? '' : ` depuis ${formatDuration(Math.floor(Date.now() / 1000) - since)}`;
        return { tone: 'danger', label: `hors ligne${forHow}` };
    }
    return { tone: 'neutral', label: 'jamais testé' };
}

/**
 * One service in the list: state, target, availability over the three usual
 * windows and its latest latency. Clicking anywhere opens the detail view; the
 * corner actions stop the click so they don't also navigate.
 *
 * Reordering hangs off the leading grip alone, like a note's block rows (see
 * {@link ../Notes/BlockEditor}) — not off the whole row. That keeps the card a
 * plain click target, and it is what makes reordering work under a finger: only
 * the grip opts out of touch scrolling (`touch-action: none`), so a drag started
 * anywhere else still scrolls the list. The gesture itself is `pointerdown`
 * rather than HTML5 `draggable` — see {@link ./ServiceList} for why.
 */
export function ServiceCard({
    service,
    onOpen,
    onEdit,
    onToggle,
    onCheckNow,
    busy,
    dragging,
    onDragPointerDown
}: ServiceCardProps) {
    const badge = statusBadge(service);
    // Quelqu'un consulte ce service, plus bas que moi : sa couleur ici.
    const outline = useLiveOutline('l1', String(service.id));
    const action = (run: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        run();
    };

    return (
        <div
            className={`${styles.card} ${service.enabled ? '' : styles.cardPaused} ${dragging ? styles.cardDragging : ''}`}
            {...outline}
            role='button'
            tabIndex={0}
            data-service-card=''
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                }
            }}
        >
            <button
                type='button'
                className={styles.grip}
                aria-label='Réordonner le service'
                onPointerDown={onDragPointerDown}
                // A press that never passed the drag threshold is still a click:
                // swallow it here so grabbing the grip can't open the service.
                onClick={(e) => e.stopPropagation()}
            >
                <span className='icon icon-drag' />
            </button>

            <div className={styles.cardMain}>
                <div className={styles.cardHead}>
                    <h4 className={styles.cardName}>{service.name}</h4>
                    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                </div>
                <p className={styles.cardUrl}>{service.url}</p>
                <p className={styles.cardMeta}>
                    {formatAgo(service.lastCheckedAt)}
                    {service.lastResponseMs !== null && ` · ${formatMs(service.lastResponseMs)}`}
                    {service.lastError && ` · ${service.lastError}`}
                </p>
            </div>

            <div className={styles.cardRatios}>
                {(
                    [
                        ['24 h', service.ratio24h],
                        ['7 j', service.ratio7d],
                        ['30 j', service.ratio30d]
                    ] as const
                ).map(([label, ratio]) => (
                    <span key={label} className={styles.ratio}>
                        <span className={styles.ratioValue}>{formatRatio(ratio)}</span>
                        <span className={styles.ratioLabel}>{label}</span>
                    </span>
                ))}
            </div>

            <div className={styles.cardActions}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    disabled={busy}
                    title='Tester maintenant'
                    aria-label='Tester maintenant'
                    onClick={action(onCheckNow)}
                >
                    <span className='icon icon-refresh' />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    disabled={busy}
                    title={service.enabled ? 'Mettre en pause' : 'Reprendre la surveillance'}
                    aria-label={service.enabled ? 'Mettre en pause' : 'Reprendre la surveillance'}
                    onClick={action(onToggle)}
                >
                    <span className={`icon icon-${service.enabled ? 'pause' : 'play'}`} />
                </button>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title='Modifier'
                    aria-label='Modifier'
                    onClick={action(onEdit)}
                >
                    <span className='icon icon-edit' />
                </button>
            </div>
        </div>
    );
}

export default ServiceCard;
