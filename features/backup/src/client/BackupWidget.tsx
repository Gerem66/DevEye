import { CountWidget, useActiveWorkspace, useResource, type CountState } from 'deveye-sdk-client';

import { api } from './api';

/**
 * Carte de comptage de l'accueil. Pas de `useWorkspaceCount` : `backup.count`
 * rend deux nombres, et le rouge suit `failing`, pas le total. `useResource`
 * garde la dernière valeur sur un échec : un « 0 » se lirait « rien à
 * sauvegarder ».
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
