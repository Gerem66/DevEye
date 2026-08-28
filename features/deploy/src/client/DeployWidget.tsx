import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de cibles de déploiement de l'espace.
 *
 * Adossée à `deploy.count`, qui ne compte que des lignes. Elle **ne montre pas**
 * l'état du dernier déploiement, et c'est délibéré : ce serait la seule tuile de
 * l'accueil à changer sans qu'on ait rien fait, pour une information dont on ne
 * fait rien à cet endroit. L'état se lit dans la feature, où l'on est venu le
 * chercher.
 */
export function DeployWidget() {
    const state = useWorkspaceCount('deploy.count');
    return <CountWidget state={state} noun='cible' hint='Vos mises en production' empty='Aucune cible déclarée' />;
}

export default DeployWidget;
