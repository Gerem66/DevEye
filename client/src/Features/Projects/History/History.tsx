import { useCallback, useEffect, useState } from 'react';
import type { MinimalUser, ProjectCard, ProjectEvent, ProjectEventKind } from '@deveye/types';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { humanizeError, withSecrecy } from '../api';
import { Avatar } from '../Board/Avatar';
import styles from '../style.module.css';

/** Intitulé et pastille de chaque type d'événement. */
const KIND_META: Record<ProjectEventKind, { icon: string; text: string }> = {
    'project.created': { icon: 'star', text: 'Projet créé' },
    'project.renamed': { icon: 'edit', text: 'Renommé' },
    'project.version': { icon: 'v', text: 'Version' },
    'project.status': { icon: 'activity', text: 'Statut' },
    'project.securityTier': { icon: 'lock', text: 'Confidentialité' },
    'project.archived': { icon: 'archive', text: 'Projet archivé' },
    'project.restored': { icon: 'refresh', text: 'Projet restauré' },
    'card.archived': { icon: 'archive', text: 'Bloc archivé' },
    'card.restored': { icon: 'refresh', text: 'Bloc restauré' },
    'milestone.reached': { icon: 'check-circle', text: 'Jalon atteint' },
    'deploy.triggered': { icon: 'rocket', text: 'Déploiement lancé' },
    'deploy.succeeded': { icon: 'check-circle', text: 'Déploiement réussi' },
    'deploy.failed': { icon: 'x-circle', text: 'Déploiement échoué' }
};

interface HistoryProps {
    projectId: number;
    members: MinimalUser[];
    /** Les cartes archivées, pour ouvrir un bloc en lecture seule. */
    archivedCards: ProjectCard[];
    onOpenArchived: (card: ProjectCard) => void;
}

/**
 * L'historique d'un projet : une frise **verticale**, tenue par un trait fin sur
 * la gauche.
 *
 * Volontairement sobre. C'est une page qu'on ouvre rarement, pour répondre à une
 * question précise — « quand a-t-on archivé ça ? », « depuis quand est-on en
 * v2 ? ». Elle ne cherche donc pas à attirer l'œil, seulement à être lisible
 * quand on la consulte.
 */
export function History({ projectId, members, archivedCards, onOpenArchived }: HistoryProps) {
    const [events, setEvents] = useState<ProjectEvent[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('project.board');

    const load = useCallback(
        async (before?: number) => {
            try {
                const res = await withSecrecy(() =>
                    ws.send('project.eventList', before === undefined ? { projectId } : { projectId, before })
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
                        const actor = members.find((m) => m.id === event.actorUserId);
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
                                        {event.actorUserId !== null && <Avatar user={actor} size={18} />}
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
