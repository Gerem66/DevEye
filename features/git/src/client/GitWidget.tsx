import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de dépôts de l'espace.
 *
 * Adossée à `git.count`, qui ne compte qu'une colonne claire — la carte
 * n'ouvre donc jamais l'invite de mot de passe. Rien du git d'un espace n'est
 * chiffré à l'étage gardé, de toute façon.
 */
export function GitWidget() {
    const state = useWorkspaceCount('git.count');
    return <CountWidget state={state} noun='dépôt' hint='Vos dépôts suivis' empty='Aucun dépôt' />;
}

export default GitWidget;
