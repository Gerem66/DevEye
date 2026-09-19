import { useMemo } from 'react';
import { useWorkspacePermissions } from 'deveye-sdk-client';
import { manifest } from '../manifest';
import type { ProjectCard } from '../contracts/domain';

/**
 * Ce que l'appelant a le droit de faire dans CE projet. Les cinq permissions
 * propres du module se surchargent projet par projet (onglet Permissions de sa
 * fiche) : toutes se lisent donc avec son identifiant, jamais à l'échelle de la
 * fonctionnalité seule, sous peine de proposer un geste que le serveur refuse.
 *
 * Ce qui est refusé se grise avec sa raison plutôt que de disparaître : le
 * projet garde la même forme pour tout le monde, et l'infobulle nomme la case à
 * cocher, mot pour mot celle de l'éditeur de rôles.
 */
export interface ProjectRights {
    canWrite: boolean;
    canManage: boolean;
    canTasks: boolean;
    canPlan: boolean;
    canLinks: boolean;
    canChat: boolean;
    /**
     * La tâche revient à l'appelant : celle qu'il porte, ou celle qu'il a
     * écrite et que personne n'a prise. Sans le droit de planifier, c'est la
     * seule qu'il puisse dater, et le serveur applique la même règle.
     */
    ownsCard(card: ProjectCard): boolean;
    /** Poser ou déplacer les dates de cette tâche. */
    canDate(card: ProjectCard): boolean;
}

/** L'intitulé d'une permission propre, tel que l'éditeur de rôles l'affiche. */
function labelOf(key: string): string {
    return manifest.extraPermissions.find((p) => p.key === key)?.label ?? key;
}

/** Ce qui manque pour ce geste, en une phrase d'infobulle. */
export function missingPermission(key: string): string {
    return `Permission « ${labelOf(key)} » requise sur Projets`;
}

export const NO_WRITE = 'Droit d’écriture requis sur Projets';

/** La raison d'un refus, ou `undefined` quand le geste est ouvert. */
export function denial(canWrite: boolean, held: boolean, key: string): string | undefined {
    if (!canWrite) return NO_WRITE;
    return held ? undefined : missingPermission(key);
}

export function useProjectRights(projectId: number, meUserId: number): ProjectRights {
    const permissions = useWorkspacePermissions();
    const item = String(projectId);
    const canWrite = permissions.canFeature('projects', 'write', item);
    const canPlan = canWrite && permissions.canExtra('projects', 'plan', item);

    return useMemo(() => {
        const ownsCard = (card: ProjectCard) =>
            card.assigneeUserId === meUserId || (card.assigneeUserId === null && card.authorUserId === meUserId);
        return {
            canWrite,
            canManage: canWrite && permissions.canExtra('projects', 'manageProjects', item),
            canTasks: canWrite && permissions.canExtra('projects', 'tasks', item),
            canPlan,
            canLinks: canWrite && permissions.canExtra('projects', 'links', item),
            canChat: canWrite && permissions.canExtra('projects', 'chat', item),
            ownsCard,
            canDate: (card) => canWrite && (canPlan || ownsCard(card))
        };
    }, [permissions, item, meUserId, canWrite, canPlan]);
}
