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
 * L'histoire d'un projet, tâches archivées comprises, dans le dernier onglet de
 * ses réglages : on l'ouvre rarement, pour une question précise, et elle prenait
 * un onglet de la barre toute la journée pour ça.
 *
 * Deux droits distincts dans une seule liste : le reste de l'histoire demande la
 * permission « Consulter l'historique », les tâches archivées se lisent dès qu'on
 * voit le projet, parce que c'est d'ici seulement qu'on en restaure une, et que
 * l'archivage est la seule sortie d'une tâche.
 */
export default function ProjectHistoryPanel({ scope, canWrite }: SettingsPanelProps) {
    const projectId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const permissions = useWorkspacePermissions();
    const item = projectId === null ? '' : String(projectId);
    const canHistory = permissions.canExtra('projects', 'history', item);
    const canTasks = canWrite && permissions.canExtra('projects', 'tasks', item);

    const [archived, setArchived] = useState<ProjectCard[] | null>(null);
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
                <span className={shell.sectionLabel}>Historique</span>
                <p className={shell.sectionHint}>
                    Une tâche archivée s’ouvre d’un clic, et c’est d’ici qu’elle se restaure.
                </p>
                {!canHistory && (
                    <ReadOnlyNotice>
                        {missingPermission('history')} : seules les tâches archivées paraissent ici.
                    </ReadOnlyNotice>
                )}
                <History
                    projectId={projectId}
                    withEvents={canHistory}
                    archivedCards={archived}
                    onOpenArchived={setViewing}
                />
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
