import { PlanPausedBadge, StatusBadge, useLiveOutline } from 'deveye-sdk-client';
import type { UptimeService } from '../contracts/domain';

import { formatDuration, formatEvery, formatMs } from '../contracts/format';
import { formatAgo } from './format';
import Ratios from './Ratios';
import StatusBars from './StatusBars';
import { useServiceHistory } from './useServiceHistory';
import styles from './style.module.css';

interface ServiceCardProps {
    service: UptimeService;
    onOpen: () => void;
    /** Card being dragged right now: dimmed, never restyled otherwise. */
    dragging: boolean;
    onDragPointerDown: (e: React.PointerEvent) => void;
}

/** Badge tone + label for a service's live state. */
function statusBadge(service: UptimeService): { tone: 'online' | 'danger' | 'neutral'; label: string } {
    // Tenu en pause par l'offre, son dernier état est figé : le montrer mentirait.
    if (!service.enabled || service.planPaused) return { tone: 'neutral', label: 'en pause' };
    if (service.status === 'up') return { tone: 'online', label: 'en ligne' };
    if (service.status === 'down') {
        const since = service.downSince;
        const forHow = since === null ? '' : ` depuis ${formatDuration(Math.floor(Date.now() / 1000) - since)}`;
        return { tone: 'danger', label: `${service.integrityDrift ? 'fichiers modifiés' : 'hors ligne'}${forHow}` };
    }
    return { tone: 'neutral', label: 'jamais testé' };
}

/**
 * Un service dans la liste. Cliquer n'importe où ouvre sa fiche, et rien
 * d'autre : « tester » vit sur la fiche, la pause et le reste dans l'onglet
 * Général de ses réglages, pas sur chaque ligne.
 *
 * Le réordonnancement ne tient qu'à la poignée : elle seule refuse le
 * défilement tactile (`touch-action: none`), un glissement commencé ailleurs
 * fait toujours défiler la liste.
 */
export function ServiceCard({ service, onOpen, dragging, onDragPointerDown }: ServiceCardProps) {
    const badge = statusBadge(service);
    const paused = !service.enabled || service.planPaused;
    // Quelqu'un consulte ce service, plus bas que moi : sa couleur ici.
    const outline = useLiveOutline('l1', String(service.id));
    const { points, resolution, axis } = useServiceHistory(service.id, service.lastCheckedAt);

    return (
        <div
            className={`${styles.card} ${paused ? styles.cardPaused : ''} ${dragging ? styles.cardDragging : ''}`}
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
                    {service.integrityIntervalSeconds !== null && (
                        <span title='Les fichiers que sert le site sont aussi comparés à une référence'>
                            <StatusBadge tone='accent'>intégrité</StatusBadge>
                        </span>
                    )}
                    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                    {service.planPaused && <PlanPausedBadge />}
                    {/* Projeté depuis un autre espace : le serveur refuse de le
                        supprimer d'ici, et rien d'autre ne le distingue d'une
                        ligne locale. */}
                    {service.foreign && (
                        <span title='Ce service appartient à un autre espace qui le partage ici'>
                            <StatusBadge tone='accent'>partagé</StatusBadge>
                        </span>
                    )}
                </div>
                <p className={styles.cardUrl}>{service.url}</p>
                <p className={styles.cardMeta}>
                    {formatAgo(service.lastCheckedAt)}
                    {service.enabled && ` · ${formatEvery(service.intervalSeconds)}`}
                    {service.lastResponseMs !== null && ` · ${formatMs(service.lastResponseMs)}`}
                    {service.lastError && ` · ${service.lastError}`}
                </p>
            </div>

            {/* La bande ne capte pas le clic : cliquer une barre ouvre la fiche,
                comme cliquer ailleurs. */}
            <div className={styles.cardGraph}>
                <StatusBars points={points} from={axis.from} to={axis.to} resolution={resolution} variant='inline' />
            </div>

            <Ratios service={service} />
        </div>
    );
}

export default ServiceCard;
