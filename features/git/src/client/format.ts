import type { ProjectStatus } from '@deveye/types';

/**
 * Les libellés des états d'un projet, pour la liste des projets qui utilisent un
 * dépôt. Copie assumée de ceux de Projets : un module n'en importe pas un autre,
 * et le SDK n'expose que le vocabulaire des statuts, pas ses libellés.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};
