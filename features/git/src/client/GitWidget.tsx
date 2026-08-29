import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de dépôts de l'espace. Rien du git
 * n'est chiffré à l'étage gardé, donc la carte n'ouvre jamais l'invite de mot
 * de passe.
 */
export function GitWidget() {
    const state = useWorkspaceCount('git.count');
    return <CountWidget state={state} noun='dépôt' hint='Vos dépôts suivis' empty='Aucun dépôt' />;
}

export default GitWidget;
