import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/** Carte compacte de l'accueil : le nombre de bases ; ne joint aucun serveur. */
export function DatabaseWidget() {
    const state = useWorkspaceCount('database.count');
    return <CountWidget state={state} noun='base' hint='Vos bases suivies' empty='Aucune base' />;
}

export default DatabaseWidget;
