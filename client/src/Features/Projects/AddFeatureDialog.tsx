import { invalidate } from '@/stores/invalidation';
import { LinkRepoDialog } from './Git/LinkRepoDialog';
import { LinkDatabaseDialog } from './Database/LinkDatabaseDialog';
import { LinkSiteDialog } from './Audience/LinkSiteDialog';
import { LinkTargetDialog } from './Deploy/LinkTargetDialog';
import type { ProjectFeatureTabId } from './tabs';

/**
 * Rien de relié, par construction.
 *
 * Le menu « + » ne propose que des features à zéro élément : la liste des
 * éléments déjà liés, dont les dialogues se servent pour retirer des choix
 * possibles, est donc forcément vide. Constante partagée pour garder une
 * identité stable d'un rendu à l'autre.
 */
const NOTHING_LINKED: number[] = [];

interface AddFeatureDialogProps {
    projectId: number;
    /** La feature dont l'ajout est en cours, ou `null` si le menu n'a rien lancé. */
    pending: ProjectFeatureTabId | null;
    onClose: () => void;
    /** L'ajout a abouti : l'onglet a désormais de quoi s'ouvrir. */
    onAdded: (id: ProjectFeatureTabId) => void;
}

/**
 * Les formulaires d'ajout du menu « + », montés au niveau du projet.
 *
 * **Les mêmes dialogues que ceux des onglets**, et non des copies : ajouter un
 * dépôt depuis la barre ou depuis l'onglet Git doit être exactement le même
 * geste, avec le même formulaire — une seconde implémentation divergerait au
 * premier réglage ajouté. Ils sont montés ici parce que l'onglet, lui, n'existe
 * pas encore : c'est précisément ce que l'ajout va faire naître.
 *
 * Les deux points d'entrée ne se marchent jamais dessus : le menu ne propose que
 * ce qui est absent de la barre, et le bouton d'un onglet n'existe que s'il y
 * est. Les quatre restent montés fermés pour que la fermeture s'anime, comme
 * partout ailleurs ; leurs requêtes, elles, ne partent qu'à l'ouverture.
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
                    invalidate('project.board', 'git.list', 'git.count');
                    onAdded('git');
                }}
            />

            <LinkDatabaseDialog
                open={pending === 'database'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('project.board', 'database.list', 'database.count');
                    onAdded('database');
                }}
            />

            <LinkSiteDialog
                open={pending === 'audience'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('project.board', 'audience.list', 'audience.count');
                    onAdded('audience');
                }}
            />

            <LinkTargetDialog
                open={pending === 'deploy'}
                projectId={projectId}
                linkedIds={NOTHING_LINKED}
                onClose={onClose}
                onSaved={() => {
                    invalidate('project.board', 'deploy.list', 'deploy.count');
                    onAdded('deploy');
                }}
            />
        </>
    );
}

export default AddFeatureDialog;
