import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Carte compacte de l'accueil : le nombre de sites suivis de l'espace.
 *
 * Adossée à `audience.count`, qui ne compte que des lignes. Elle **ne montre
 * pas** de visiteurs en direct, et c'est délibéré : ce chiffre-là change en
 * permanence, et une tuile qui bouge sans arrêt sur la page d'accueil attire
 * l'œil pour une information dont on ne fait rien à cet endroit. Le direct est
 * dans la fiche du site, là où on est venu le lire.
 */
export function AudienceWidget() {
    const state = useWorkspaceCount('audience.count');
    return <CountWidget state={state} noun='site' hint='Vos sites suivis' empty='Aucun site suivi' />;
}

export default AudienceWidget;
