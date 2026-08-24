import { StatusBadge } from '@/Components/StatusBadge';

import { formatAgo, formatDuration, formatMs } from './format';
import Ratios from './Ratios';
import StatusBars from './StatusBars';
import { useServiceHistory } from './useServiceHistory';
import styles from './style.module.css';

import type { UptimeService } from '@deveye/types';
import { useLiveOutline } from '@/live/useLiveOutline';

interface ServiceCardProps {
    service: UptimeService;
    onOpen: () => void;
    onEdit: () => void;
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
 * One service in the list: state, target, the last 24 h as a status strip,
 * availability over the three usual windows and its latest latency. Clicking
 * anywhere opens the detail view; the corner action stops the click so it
 * doesn't also navigate.
 *
 * **Lire, pas piloter.** La carte portait aussi « tester maintenant » et « mettre
 * en pause ». Deux boutons par ligne, sur toute une liste, pour des gestes qu'on
 * fait une fois par mois — et qui vivent déjà là où l'on se rend pour les faire :
 * la fiche du service porte « Tester », son formulaire porte la pause. Ce qu'on
 * parcourt du regard, on le parcourt mieux sans.
 *
 * La bande d'état a pris leur place, au milieu. C'est elle qui répond à la
 * question qu'on se pose en survolant une liste — « et depuis quand ? » — là où
 * les trois pourcentages, seuls, disaient combien sans dire quand.
 *
 * Reordering hangs off the leading grip alone, like a note's block rows (see
 * {@link ../Notes/BlockEditor}) — not off the whole row. That keeps the card a
 * plain click target, and it is what makes reordering work under a finger: only
 * the grip opts out of touch scrolling (`touch-action: none`), so a drag started
 * anywhere else still scrolls the list. The gesture itself is `pointerdown`
 * rather than HTML5 `draggable` — see {@link ./ServiceList} for why.
 */
export function ServiceCard({ service, onOpen, onEdit, dragging, onDragPointerDown }: ServiceCardProps) {
    const badge = statusBadge(service);
    // Quelqu'un consulte ce service, plus bas que moi : sa couleur ici.
    const outline = useLiveOutline('l1', String(service.id));
    const { points, resolution, axis } = useServiceHistory(service.id, service.lastCheckedAt);
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
                    {/* Projeté depuis un autre espace : il se lit et se modifie
                        comme les autres, mais le supprimer d'ici toucherait la
                        donnée d'ailleurs — et le serveur le refuse. Sans cette
                        pastille, rien ne distingue une ligne locale d'une
                        fenêtre sur l'espace voisin. */}
                    {service.foreign && (
                        <span title='Ce service appartient à un autre espace qui le partage ici'>
                            <StatusBadge tone='accent'>partagé</StatusBadge>
                        </span>
                    )}
                </div>
                <p className={styles.cardUrl}>{service.url}</p>
                <p className={styles.cardMeta}>
                    {formatAgo(service.lastCheckedAt)}
                    {service.lastResponseMs !== null && ` · ${formatMs(service.lastResponseMs)}`}
                    {service.lastError && ` · ${service.lastError}`}
                </p>
            </div>

            {/* La bande ne capte pas le clic : elle n'a que du survol à offrir, et
                le reste de la ligne mène au service. Cliquer une barre ouvre donc
                la fiche, comme cliquer ailleurs — ce qui est exactement le geste
                qu'on a en tête quand on vient de repérer un creux rouge. */}
            <div className={styles.cardGraph}>
                <StatusBars points={points} from={axis.from} to={axis.to} resolution={resolution} variant='inline' />
            </div>

            <Ratios service={service} />

            <div className={styles.cardActions}>
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
