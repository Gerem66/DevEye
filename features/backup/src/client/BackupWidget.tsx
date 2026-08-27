import { CountWidget, useActiveWorkspace, useResource, type CountState } from 'deveye-sdk-client';

import { api } from './api';

/**
 * Carte compacte de l'accueil : combien de travaux tournent, et combien sont
 * tombés.
 *
 * Rendue par le `CountWidget` partagé, comme toutes les autres cartes de
 * comptage : même géométrie, même couleur d'accent, mêmes tailles. Elle ne
 * passe pas par `useWorkspaceCount` pour autant : `backup.count` rend **deux**
 * nombres, et celui qui compte n'est pas le plus gros.
 *
 * Le nombre vire au rouge dès qu'un travail a échoué à son dernier passage.
 * C'est la seule carte de l'accueil à le faire, et c'est justifié : un compteur
 * affichant « 4 travaux » pendant que trois d'entre eux échouent depuis une
 * semaine serait pire qu'aucune carte, il donnerait la sensation d'être
 * couvert.
 *
 * `useResource` garde la dernière valeur connue sur un échec plutôt que de
 * retomber sur « 0 » : un zéro trompeur sur une carte de sauvegardes se lit
 * « rien à sauvegarder », ce qui n'est jamais la vérité.
 */
export default function BackupWidget() {
    const workspace = useActiveWorkspace();
    const { data } = useResource(
        'backup.count',
        () => api.send('backup.count', {}),
        'Le compte des sauvegardes n’a pas pu être lu.',
        [workspace?.id]
    );

    const state: CountState = data === null ? { kind: 'loading' } : { kind: 'ready', count: data.count };
    const failing = data?.failing ?? 0;

    return (
        <CountWidget
            state={state}
            noun='travail'
            plural='travaux'
            tone={failing > 0 ? 'danger' : 'neutral'}
            hint={
                failing > 0 ? `${failing} erreur${failing > 1 ? 's' : ''} au dernier passage` : 'Dernier passage réussi'
            }
            empty='Aucune sauvegarde programmée'
        />
    );
}
