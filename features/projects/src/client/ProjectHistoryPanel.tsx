import { useCallback, useEffect, useState } from 'react';
import {
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    settingsStyles as shell,
    useResourceVersion,
    useWorkspacePermissions,
    withSecrecy
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api } from './api';
import type { ProjectCard } from '../contracts/domain';
import { ArchivedCardDialog } from './History/ArchivedCardDialog';
import { History } from './History/History';
import { missingPermission } from './rights';
import styles from './style.module.css';

/**
 * L'histoire d'un projet et ses tâches archivées, dans le dernier onglet de ses
 * réglages : on l'ouvre rarement, pour une question précise, et elle prenait un
 * onglet de la barre toute la journée pour ça.
 *
 * Deux droits distincts, et un seul écran : la frise demande la permission
 * « Consulter l'historique », les tâches archivées se lisent dès qu'on voit le
 * projet, parce que c'est d'ici seulement qu'on en restaure une, et que
 * l'archivage est la seule sortie d'une tâche.
 */
export default function ProjectHistoryPanel({ scope, canWrite }: SettingsPanelProps) {
    const projectId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const permissions = useWorkspacePermissions();
    const item = projectId === null ? '' : String(projectId);
    const canHistory = permissions.canExtra('projects', 'history', item);
    const canTasks = canWrite && permissions.canExtra('projects', 'tasks', item);

    const [archived, setArchived] = useState<ProjectCard[]>([]);
    const [viewing, setViewing] = useState<ProjectCard | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('projects.board');

    const load = useCallback(async () => {
        if (projectId === null) return;
        try {
            const res = await withSecrecy(() => api.send('projects.board', { projectId, archived: true }));
            setArchived(res.cards);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les tâches archivées.'));
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load, version]);

    const restore = async () => {
        if (!viewing) return;
        setBusy(true);
        try {
            await withSecrecy(() => api.send('projects.cardRestore', { cardId: viewing.id }));
            invalidate('projects.board', 'projects.list');
            setViewing(null);
        } catch (e) {
            setError(humanizeError(e, 'La restauration a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (projectId === null) return null;

    return (
        <div className={shell.section}>
            {error && <p className={styles.error}>{error}</p>}

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Tâches archivées</span>
                {archived.length === 0 ? (
                    <p className={shell.sectionHint}>
                        Aucune tâche archivée. L’archivage est la seule sortie d’une tâche, et il se défait ici.
                    </p>
                ) : (
                    <ul className={styles.archivedList}>
                        {archived.map((card) => (
                            <li key={card.id}>
                                <button type='button' className={styles.archivedRow} onClick={() => setViewing(card)}>
                                    <span className='icon icon-archive' aria-hidden='true' />
                                    <span className={styles.dashRowName}>{card.title || 'Sans titre'}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Historique</span>
                {canHistory ? (
                    <History projectId={projectId} archivedCards={archived} onOpenArchived={setViewing} />
                ) : (
                    <ReadOnlyNotice>{missingPermission('history')}.</ReadOnlyNotice>
                )}
            </div>

            <ArchivedCardDialog
                open={viewing !== null}
                card={viewing}
                canWrite={canTasks}
                busy={busy}
                onClose={() => setViewing(null)}
                onRestore={() => void restore()}
            />
        </div>
    );
}
