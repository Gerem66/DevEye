import type { ProjectStatus } from '@deveye/types';

/**
 * Les libellés des états d'un projet, pour la liste des projets qui utilisent
 * un dépôt.
 *
 * Une copie assumée des quatre libellés de Projets (`STATUS_LABELS` de
 * `Features/Projects/api.ts`), comme dans le module Bases de données : un
 * module n'importe pas l'app, et le SDK n'expose pas les libellés d'une
 * native. Quatre mots, tenus à la main.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
    draft: 'Brouillon',
    active: 'En cours',
    paused: 'En pause',
    done: 'Terminé'
};
