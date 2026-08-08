import { CountWidget, useWorkspaceCount } from '@/Components/CountWidget';

/**
 * Carte compacte de l'accueil : le nombre de bases de l'espace.
 *
 * Adossée à `database.count`, qui ne compte que des lignes — la carte ne joint
 * aucun serveur et n'ouvre jamais l'invite de mot de passe. Rien des bases d'un
 * espace n'est chiffré à l'étage gardé, de toute façon.
 */
export function DatabaseWidget() {
    const state = useWorkspaceCount('database.count');
    return <CountWidget state={state} noun='base' hint='Vos bases suivies' empty='Aucune base' />;
}

export default DatabaseWidget;
