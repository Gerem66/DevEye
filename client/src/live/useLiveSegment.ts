import { useContext, useEffect, useMemo } from 'react';

import {
    clearLiveSegment,
    segmentTarget,
    setLiveSegment,
    useTeleport,
    type LiveSegmentKind,
    type LiveSegmentTarget
} from '@/stores/live';
import { ViewScopeContext } from '@/telemetry/ViewScope';

/**
 * Déclare le niveau de l'arborescence où se trouve ce composant, et reçoit celui
 * qu'une téléportation attend ici. Une feature annonce son propre niveau sans
 * jamais connaître l'arbre entier, et le chemin complet s'assemble tout seul.
 *
 * La cible est rendue tant qu'elle n'est pas atteinte, jamais consommée à la
 * lecture : une feature dont les données n'ont pas chargé la retrouvera au rendu
 * suivant. Une fois atteinte, elle ne revient plus. `null` en `value` déclare le
 * niveau vide et referme tout ce qui est en dessous.
 *
 * À appeler une seule fois par `kind` et par vue, dans le composant qui détient
 * la sélection : le registre d'une vue est une map par `kind`, donc plusieurs
 * déclarants s'écraseraient. Pour entourer des lignes, c'est `useLiveOutlines`
 * qu'il faut, qui n'écrit rien et se consulte autant de fois qu'on veut.
 */
export function useLiveSegment(kind: LiveSegmentKind, value: string | null): LiveSegmentTarget | null {
    const scope = useContext(ViewScopeContext);
    // Seule la téléportation intéresse ce hook : le lire sur l'état complet ferait
    // re-rendre toute feature montée à chaque trame de curseur.
    const teleport = useTeleport();

    useEffect(() => {
        setLiveSegment(scope, kind, value);
        // Au démontage le niveau disparaît : une feature fermée n'est plus un lieu.
        return () => clearLiveSegment(scope, kind, value);
    }, [scope, kind, value]);

    return useMemo(() => segmentTarget(teleport, scope, kind, value), [teleport, scope, kind, value]);
}
