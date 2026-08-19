import { useEffect, useState } from 'react';

import { CountWidget, type CountState } from '@/Components/CountWidget';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useActiveWorkspace } from '@/stores/workspace';

/**
 * Carte compacte de l'accueil : combien de travaux tournent, et combien sont
 * tombés.
 *
 * Rendue par le `CountWidget` partagé, comme toutes les autres cartes de
 * comptage — même géométrie, même couleur d'accent, mêmes tailles. Elle ne
 * passe pas par `useWorkspaceCount` pour autant : `backup.count` rend **deux**
 * nombres, et celui qui compte n'est pas le plus gros.
 *
 * Le nombre vire au rouge dès qu'un travail a échoué à son dernier passage.
 * C'est la seule carte de l'accueil à le faire, et c'est justifié : un compteur
 * affichant « 4 travaux » pendant que trois d'entre eux échouent depuis une
 * semaine serait pire qu'aucune carte — il donnerait la sensation d'être
 * couvert.
 */
export function BackupWidget() {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('backup.count');
    const [state, setState] = useState<CountState>({ kind: 'loading' });
    const [failing, setFailing] = useState(0);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            ws.send('backup.count', {})
                .then((res) => {
                    if (cancelled) return;
                    setState({ kind: 'ready', count: res.count });
                    setFailing(res.failing);
                })
                // On garde la dernière valeur connue plutôt que de retomber sur
                // « 0 » : un zéro trompeur sur une carte de sauvegardes se lit
                // « rien à sauvegarder », ce qui n'est jamais la vérité.
                .catch(() => undefined);
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

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

export default BackupWidget;
