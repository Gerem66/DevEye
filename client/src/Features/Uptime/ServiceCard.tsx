import { StatusBadge } from '@/Components/StatusBadge';

import { formatAgo, formatDuration, formatMs, formatRatio } from './format';
import styles from './style.module.css';

import type { UptimeService } from 'deveye-types';

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
 * The whole row is a drag handle, like a note card — but via `pointerdown`, not
 * HTML5 `draggable` (see {@link ../Notes/NoteGrid} for that approach, and
 * {@link ./ServiceList} for why this feature uses pointer events instead).
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
    const action = (run: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        run();
    };

    return (
        <div
            className={`${styles.card} ${service.enabled ? '' : styles.cardPaused} ${dragging ? styles.cardDragging : ''}`}
            role='button'
            tabIndex={0}
            data-service-card=''
            onPointerDown={onDragPointerDown}
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                }
            }}
        >
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
