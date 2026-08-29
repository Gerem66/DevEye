import { useEffect, useMemo } from 'react';

import {
    segmentTarget,
    setLiveSegment,
    useTeleportPath,
    type LiveSegmentKind,
    type LiveSegmentTarget
} from '@/stores/live';

/**
 * Déclare le niveau de l'arborescence où se trouve ce composant, et reçoit celui
 * qu'une téléportation attend ici. Une feature annonce son propre niveau sans
 * jamais connaître l'arbre entier, et le chemin complet s'assemble tout seul.
 *
 * La cible est rendue tant qu'elle n'est pas atteinte, jamais consommée à la
 * lecture : une feature dont les données n'ont pas chargé la retrouvera au rendu
 * suivant. `null` en `value` retire le niveau et referme tout ce qui est en
 * dessous.
 *
 * À appeler une seule fois par `kind`, dans le composant qui détient la
 * sélection : le registre est une map par `kind`, donc plusieurs déclarants
 * s'écraseraient, et celui qui se démonte effacerait ce qu'un autre vient de
 * poser. Pour entourer des lignes, c'est `useLiveOutlines` qu'il faut, qui
 * n'écrit rien et se consulte autant de fois qu'on veut.
 */
export function useLiveSegment(kind: LiveSegmentKind, value: string | null): LiveSegmentTarget | null {
    // Seule la téléportation intéresse ce hook : le lire sur l'état complet ferait
    // re-rendre toute feature montée à chaque trame de curseur.
    const teleportPath = useTeleportPath();

    useEffect(() => {
        setLiveSegment(kind, value);
        // Au démontage le niveau disparaît : une feature fermée n'est plus un lieu.
        return () => setLiveSegment(kind, null);
    }, [kind, value]);

    return useMemo(() => segmentTarget(teleportPath, kind, value), [teleportPath, kind, value]);
}
