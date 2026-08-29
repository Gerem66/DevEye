import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Le nombre de projets actifs de l'espace. `projects.count` ne lit que des
 * colonnes claires : la carte n'ouvre jamais l'invite de mot de passe.
 */
export function ProjectsWidget() {
    const state = useWorkspaceCount('projects.count');
    return <CountWidget state={state} noun='projet' hint='Vos projets en cours' empty='Aucun projet' />;
}

export default ProjectsWidget;
