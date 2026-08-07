import { CountWidget, useWorkspaceCount } from '@/Components/CountWidget';

/**
 * Carte compacte de l'accueil : le nombre de projets actifs de l'espace.
 *
 * Adossée à `project.count`, qui ne compte que des colonnes claires — les
 * projets confidentiels y sont comptés comme les autres, et la carte n'ouvre
 * donc jamais l'invite de mot de passe. Les projets archivés en sont exclus,
 * comme dans le portefeuille.
 */
export function ProjectsWidget() {
    const state = useWorkspaceCount('project.count');
    return <CountWidget state={state} noun='projet' hint='Vos projets en cours' empty='Aucun projet' />;
}

export default ProjectsWidget;
