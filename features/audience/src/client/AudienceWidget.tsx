import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de sites suivis de l'espace. Pas de
 * visiteurs en direct, délibérément : une tuile qui bouge sans arrêt attire
 * l'œil pour une information dont on ne fait rien à cet endroit.
 */
export function AudienceWidget() {
    const state = useWorkspaceCount('audience.count');
    return <CountWidget state={state} noun='site' hint='Vos sites suivis' empty='Aucun site suivi' />;
}

export default AudienceWidget;
