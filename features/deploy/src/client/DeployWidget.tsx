import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de cibles de l'espace. Pas l'état du
 * dernier déploiement : ce serait la seule tuile à changer sans qu'on ait rien
 * fait.
 */
export function DeployWidget() {
    const state = useWorkspaceCount('deploy.count');
    return <CountWidget state={state} noun='cible' hint='Vos mises en production' empty='Aucune cible déclarée' />;
}

export default DeployWidget;
