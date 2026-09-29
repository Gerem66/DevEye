import { invalidate } from 'deveye-sdk-client';
import { LinkRepoDialog } from './Git/LinkRepoDialog';
import { LinkDatabaseDialog } from './Database/LinkDatabaseDialog';
import { LinkSiteDialog } from './Audience/LinkSiteDialog';
import { LinkTargetDialog } from './Deploy/LinkTargetDialog';
import { LinkUptimeDialog } from './Uptime/LinkUptimeDialog';
import { LinkPackDialog } from './Hosting/LinkPackDialog';
import type { ProjectFeatureTabId, ProjectTabAddKey } from './tabs';

/**
 * Le menu « + » ne propose que des features à zéro élément : la liste des
 * éléments déjà liés dont se servent les dialogues est forcément vide.
 * Constante partagée pour garder une identité stable d'un rendu à l'autre.
 */
const NOTHING_LINKED: number[] = [];

interface AddFeatureDialogProps {
    projectId: number;
    /** Le geste dont l'ajout est en cours, ou `null` si le menu n'a rien lancé. */
    pending: ProjectTabAddKey | null;
    onClose: () => void;
    onAdded: (id: ProjectFeatureTabId) => void;
}

/**
 * Les formulaires d'ajout du menu « + » : les mêmes dialogues que ceux des
 * onglets, montés ici parce que l'onglet n'existe pas encore. Tous restent
 * montés fermés pour que la fermeture s'anime, leurs requêtes ne partant qu'à
 * l'ouverture.
 */
export function AddFeatureDialog({ projectId, pending, onClose, onAdded }: AddFeatureDialogProps) {
    return (
        <>
            <LinkRepoDialog
                open={pending === 'git'}
                projectId={projectId}
                linkedRepoIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'git.list', 'git.count');
                    onAdded('git');
                }}
            />

            <LinkDatabaseDialog
                open={pending === 'database'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'database.list', 'database.count');
                    onAdded('database');
                }}
            />

            <LinkSiteDialog
                open={pending === 'audience'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'audience.list', 'audience.count');
                    onAdded('audience');
                }}
            />

            <LinkTargetDialog
                open={pending === 'deploy'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'deploy.list', 'deploy.count');
                    onAdded('deploy');
                }}
            />

            <LinkUptimeDialog
                open={pending === 'uptime'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'uptime.list', 'uptime.count');
                    onAdded('uptime');
                }}
            />

            <LinkPackDialog
                open={pending === 'x-hosting'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('projects.board', 'x-hosting.list', 'x-hosting.count');
                    onAdded('x-hosting');
                }}
            />
        </>
    );
}

export default AddFeatureDialog;
