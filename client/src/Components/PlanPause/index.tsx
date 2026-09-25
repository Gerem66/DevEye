import Button from '@/Components/Button';
import { StatusBadge } from '@/Components/StatusBadge';
import { openAccountView } from '@/stores/accountView';
import { useWorkspacePermissions } from '@/stores/workspace';
import styles from './PlanPause.module.css';

/**
 * Un élément que l'offre de son propriétaire tient en pause : la même pastille
 * dans toutes les fonctionnalités, distincte d'une pause que l'utilisateur a
 * choisie.
 */
export function PlanPausedBadge({ className }: { className?: string }) {
    return (
        <span title='Il dépasse la limite de l’offre, et reprend dès qu’elle le permet.'>
            <StatusBadge tone='warning' className={className}>
                Au-delà de l’offre
            </StatusBadge>
        </span>
    );
}

/**
 * Le bandeau d'une liste qui compte des éléments en pause : combien, pourquoi,
 * ce qui tourne encore, et pour le propriétaire le chemin vers les offres.
 * Muet à 0. Les phrases évitent tout accord : le nom est celui du module.
 */
export function PlanPausedNotice({ count, one, many }: { count: number; one: string; many: string }) {
    const { isOwner } = useWorkspacePermissions();
    if (count <= 0) return null;
    return (
        <div className={styles.notice} role='status'>
            <div>
                <p className={styles.title}>
                    {count} {count === 1 ? one : many} en pause
                </p>
                <p>
                    {isOwner
                        ? 'Au-delà de la limite de l’offre de votre compte, ce qui a été créé en dernier est en pause, le reste continue de tourner. Rien n’est supprimé : tout reprend dès que l’offre le permet, ou qu’une place se libère.'
                        : 'Au-delà de la limite de l’offre du propriétaire de l’espace, ce qui a été créé en dernier est en pause, le reste continue de tourner. Rien n’est supprimé, et lui seul peut changer l’offre.'}
                </p>
            </div>
            {isOwner && <Button onClick={() => openAccountView()}>Voir les offres</Button>}
        </div>
    );
}
