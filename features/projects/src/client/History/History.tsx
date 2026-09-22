import { useCallback, useEffect, useState } from 'react';
import { humanizeError, useResourceVersion, withSecrecy } from 'deveye-sdk-client';
import { api } from '../api';
import type { ProjectCard, ProjectEvent, ProjectEventKind } from '../../contracts/domain';
import { MemberAvatar } from '../Member';
import styles from '../style.module.css';

/** Intitulé et pastille de chaque type d'événement. */
const KIND_META: Record<ProjectEventKind, { icon: string; text: string }> = {
    'projects.created': { icon: 'star', text: 'Projet créé' },
    'projects.renamed': { icon: 'edit', text: 'Renommé' },
    'projects.version': { icon: 'v', text: 'Version' },
    'projects.status': { icon: 'activity', text: 'Statut' },
    'projects.securityTier': { icon: 'lock', text: 'Confidentialité' },
    'projects.archived': { icon: 'archive', text: 'Projet archivé' },
    'projects.restored': { icon: 'refresh', text: 'Projet restauré' },
    'card.archived': { icon: 'archive', text: 'Bloc archivé' },
    'card.restored': { icon: 'refresh', text: 'Bloc restauré' },
    'column.purged': { icon: 'archive', text: 'Colonne vidée' },
    'milestone.reached': { icon: 'check-circle', text: 'Jalon atteint' },
    'deploy.triggered': { icon: 'rocket', text: 'Déploiement lancé' },
    'deploy.succeeded': { icon: 'check-circle', text: 'Déploiement réussi' },
    'deploy.failed': { icon: 'x-circle', text: 'Déploiement échoué' }
};

interface HistoryProps {
    projectId: number;
    /** Les cartes archivées, pour ouvrir un bloc en lecture seule. */
    archivedCards: ProjectCard[];
    onOpenArchived: (card: ProjectCard) => void;
}

/**
 * L'historique d'un projet : une frise verticale, tenue par un trait fin à
 * gauche. Volontairement sobre : on l'ouvre rarement, pour une question précise
 * (quand a-t-on archivé ceci, depuis quand est-on en v2). D'où sa place, le
 * dernier onglet des réglages du projet.
 */
export function History({ projectId, archivedCards, onOpenArchived }: HistoryProps) {
    const [events, setEvents] = useState<ProjectEvent[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('projects.board');

    const load = useCallback(
        async (before?: number) => {
            try {
                const res = await withSecrecy(() =>
                    api.send('projects.eventList', before === undefined ? { projectId } : { projectId, before })
                );
                setHasMore(res.hasMore);
                setEvents((prev) => (before === undefined ? res.events : [...(prev ?? []), ...res.events]));
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger l’historique.'));
            }
        },
        [projectId]
    );

    useEffect(() => {
        void load();
    }, [load, version]);

    return (
        <div className={styles.history}>
            {error && <p className={styles.error}>{error}</p>}
            {events === null && <p className={styles.empty}>Chargement…</p>}
            {events?.length === 0 && <p className={styles.empty}>Rien dans l’historique pour l’instant.</p>}

            {events && events.length > 0 && (
                <ol className={styles.histList}>
                    {events.map((event) => {
                        const meta = KIND_META[event.kind];
                        // Une carte archivée s'ouvre en lecture seule ; une carte
                        // restaurée est revenue au tableau, il n'y a rien à
                        // rouvrir ici.
                        const card =
                            event.kind === 'card.archived' && event.refId !== null
                                ? archivedCards.find((c) => c.id === event.refId)
                                : undefined;
                        return (
                            <li key={event.id} className={styles.histItem}>
                                <span className={styles.histDot} aria-hidden='true'>
                                    <span className={`icon icon-${meta.icon}`} />
                                </span>
                                <div className={styles.histBody}>
                                    <div className={styles.histHead}>
                                        <span className={styles.histKind}>{meta.text}</span>
                                        <span className={styles.histTime}>{formatWhen(event.created)}</span>
                                        {/* Masqué s'il n'est pas membre d'ici (projet projeté). */}
                                        {event.actorUserId !== null && (
                                            <MemberAvatar userId={event.actorUserId} size={18} />
                                        )}
                                    </div>
                                    <p className={styles.histLabel}>
                                        {card ? (
                                            <button
                                                type='button'
                                                className={styles.histLink}
                                                onClick={() => onOpenArchived(card)}
                                            >
                                                {event.label || 'Sans titre'}
                                            </button>
                                        ) : (
                                            event.label || <span className={styles.masked}>—</span>
                                        )}
                                    </p>
                                    {(event.from !== null || event.to !== null) && (
                                        <p className={styles.histDiff}>
                                            <span className={styles.histFrom}>{event.from || '—'}</span>
                                            {' → '}
                                            <span>{event.to || '—'}</span>
                                        </p>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}

            {hasMore && (
                <button
                    type='button'
                    className={styles.loadMore}
                    onClick={() => void load(events?.[events.length - 1]?.id)}
                >
                    Charger la suite
                </button>
            )}
        </div>
    );
}

function formatWhen(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export default History;
