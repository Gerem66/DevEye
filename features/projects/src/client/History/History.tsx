import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { humanizeError, useResourceVersion, withSecrecy } from 'deveye-sdk-client';
import type { ProjectStatus } from '@deveye/types';
import { api, STATUS_LABELS } from '../api';
import type { ProjectCard, ProjectEvent, ProjectEventKind } from '../../contracts/domain';
import { MemberAvatar } from '../Member';
import { historyEntries } from './entries';
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
    'projects.publication': { icon: 'eye-open', text: 'Page publique' },
    'projects.repoLink': { icon: 'branch', text: 'Liaisons' },
    'projects.repoUnlink': { icon: 'branch', text: 'Liaisons' },
    'projects.databaseUnlink': { icon: 'database', text: 'Liaisons' },
    'projects.audienceUnlink': { icon: 'globe', text: 'Liaisons' },
    'projects.hostingUnlink': { icon: 'folder', text: 'Liaisons' },
    'projects.deployLink': { icon: 'rocket', text: 'Liaisons' },
    'projects.deployUnlink': { icon: 'rocket', text: 'Liaisons' },
    'card.archived': { icon: 'archive', text: 'Tâche archivée' },
    'card.restored': { icon: 'refresh', text: 'Tâche restaurée' },
    'column.purged': { icon: 'archive', text: 'Colonne vidée' },
    'milestone.reached': { icon: 'check-circle', text: 'Jalon atteint' },
    'deploy.triggered': { icon: 'rocket', text: 'Déploiement lancé' },
    'deploy.succeeded': { icon: 'check-circle', text: 'Déploiement réussi' },
    'deploy.failed': { icon: 'x-circle', text: 'Déploiement échoué' }
};

const TIER_LABELS: Record<string, string> = { open: 'Standard', guarded: 'Confidentiel' };

interface HistoryProps {
    projectId: number;
    /** Sans la permission « Consulter l'historique », seules les tâches archivées paraissent. */
    withEvents: boolean;
    /** `null` le temps du chargement. */
    archivedCards: ProjectCard[] | null;
    onOpenArchived: (card: ProjectCard) => void;
}

/**
 * L'historique d'un projet, tâches archivées comprises : une ligne par entrée,
 * pour en lire beaucoup d'un coup d'œil. On l'ouvre rarement, pour une question
 * précise (quand a-t-on archivé ceci, depuis quand est-on en v2).
 */
export function History({ projectId, withEvents, archivedCards, onOpenArchived }: HistoryProps) {
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
        if (withEvents) {
            void load();
        } else {
            setEvents([]);
            setHasMore(false);
        }
    }, [load, version, withEvents]);

    const entries = events && archivedCards ? historyEntries(events, hasMore, archivedCards) : null;

    return (
        <div className={styles.history}>
            {error && <p className={styles.error}>{error}</p>}
            {entries === null && <p className={styles.empty}>Chargement…</p>}
            {entries?.length === 0 && (
                <p className={styles.empty}>
                    {withEvents ? 'Rien dans l’historique pour l’instant.' : 'Aucune tâche archivée.'}
                </p>
            )}

            {entries && entries.length > 0 && (
                <ol className={styles.histList}>
                    {entries.map((entry) => {
                        if (entry.type === 'card') {
                            const { card } = entry;
                            return (
                                <Line
                                    key={`card:${card.id}`}
                                    icon='archive'
                                    kind='Tâche archivée'
                                    at={card.archivedAt}
                                    actorUserId={null}
                                    title={card.title || 'Sans titre'}
                                    onOpen={() => onOpenArchived(card)}
                                >
                                    {card.title || 'Sans titre'}
                                </Line>
                            );
                        }
                        const { event, card } = entry;
                        const meta = KIND_META[event.kind];
                        const { text, title } = describe(event);
                        return (
                            <Line
                                key={event.id}
                                icon={meta.icon}
                                kind={meta.text}
                                at={event.created}
                                actorUserId={event.actorUserId}
                                title={title}
                                // Une tâche restaurée depuis est revenue au tableau :
                                // il n'y a plus rien à rouvrir ici.
                                onOpen={card ? () => onOpenArchived(card) : undefined}
                            >
                                {text}
                            </Line>
                        );
                    })}
                </ol>
            )}

            {withEvents && hasMore && (
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

interface LineProps {
    icon: string;
    kind: string;
    at: number | null;
    /** `null` : une tâche de fond, un compte supprimé, ou un auteur que l'entrée ne retient pas. */
    actorUserId: number | null;
    /** Le texte entier, que la ligne abrège. */
    title: string;
    /** Absent : la ligne ne s'ouvre pas. */
    onOpen?: () => void;
    children: ReactNode;
}

function Line({ icon, kind, at, actorUserId, title, onOpen, children }: LineProps) {
    const content = (
        <>
            <span className={`icon icon-${icon} ${styles.histIcon}`} aria-hidden='true' />
            <span className={styles.histKind}>{kind}</span>
            <span className={styles.histText} title={title}>
                {children}
            </span>
            {at !== null ? (
                <time className={styles.histTime} dateTime={new Date(at * 1000).toISOString()} title={longWhen(at)}>
                    {shortWhen(at)}
                </time>
            ) : (
                <span className={styles.histTime} />
            )}
            {/* Masqué s'il n'est pas membre d'ici (projet projeté). La place reste
                tenue sans lui : les dates s'alignent d'une ligne à l'autre. */}
            <span className={styles.histActor}>
                {actorUserId !== null && <MemberAvatar userId={actorUserId} size={16} />}
            </span>
        </>
    );
    return (
        <li>
            {onOpen ? (
                <button type='button' className={`${styles.histRow} ${styles.histRowOpen}`} onClick={onOpen}>
                    {content}
                </button>
            ) : (
                <div className={styles.histRow}>{content}</div>
            )}
        </li>
    );
}

/** Le texte d'une entrée, et sa version entière pour l'infobulle. */
function describe(event: ProjectEvent): { text: ReactNode; title: string } {
    if (event.kind === 'column.purged') {
        const count = Number(event.to);
        const line = `${event.label || 'Sans nom'} · ${count} tâche${count > 1 ? 's' : ''}`;
        return { text: line, title: line };
    }
    if (event.from !== null || event.to !== null) {
        const from = valueOf(event.kind, event.from);
        const to = valueOf(event.kind, event.to);
        return {
            text: (
                <>
                    <span className={styles.histFrom}>{from}</span> → {to}
                </>
            ),
            title: `${from} → ${to}`
        };
    }
    if (!event.label) return { text: <span className={styles.masked}>Sans libellé</span>, title: 'Sans libellé' };
    return { text: event.label, title: event.label };
}

/** Une valeur d'avant ou d'après, dite comme l'interface la dit. */
function valueOf(kind: ProjectEventKind, value: string | null): string {
    if (value === null || value === '') return 'aucune';
    if (kind === 'projects.status') return STATUS_LABELS[value as ProjectStatus] ?? value;
    if (kind === 'projects.securityTier') return TIER_LABELS[value] ?? value;
    return value;
}

/** Court : l'année seulement quand ce n'est pas celle-ci, et alors sans l'heure. */
function shortWhen(seconds: number): string {
    const date = new Date(seconds * 1000);
    return date.getFullYear() === new Date().getFullYear()
        ? date.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function longWhen(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
}

export default History;
