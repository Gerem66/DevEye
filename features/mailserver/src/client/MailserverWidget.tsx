import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/** Carte compacte de l'accueil : le nombre d'adresses hébergées. */
export function MailserverWidget() {
    const state = useWorkspaceCount('mailserver.count');
    return <CountWidget state={state} noun='adresse' hint='Hébergées ici' empty='Aucune adresse' />;
}

export default MailserverWidget;
