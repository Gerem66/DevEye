import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/** La carte de l'accueil : le nombre d'apps suivies. Ni chiffre ni montant, qui ont leur fiche. */
export function AppStoresWidget() {
    const state = useWorkspaceCount('appstores.count');
    return <CountWidget state={state} noun='app' hint='Vos apps suivies' empty='Aucune app suivie' />;
}

export default AppStoresWidget;
