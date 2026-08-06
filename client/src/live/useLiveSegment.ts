import { useEffect, useMemo } from 'react';

import { segmentTarget, setLiveSegment, useLive, type LiveSegmentKind, type LiveSegmentTarget } from '@/stores/live';

/**
 * Déclare le niveau de l'arborescence où se trouve ce composant, **et** reçoit
 * celui qu'une téléportation attend ici.
 *
 * C'est tout ce qu'une feature a à faire pour entrer dans le moteur de présence :
 * elle annonce son propre niveau, sans jamais connaître l'arbre entier.
 * L'accueil déclare `view`, Mail déclare `account` puis `folder`, et le chemin
 * complet — `view:mail account:12 folder:34` — s'assemble tout seul.
 *
 * ```tsx
 * const target = useLiveSegment('account', selectedId ? String(selectedId) : null);
 * useEffect(() => {
 *     if (!target) return;                       // rien de demandé
 *     const id = target.value === null ? null : Number(target.value);
 *     if (id !== null && !accounts.some((a) => a.id === id)) return;  // pas encore chargé
 *     setSelectedId(id);
 * }, [target, accounts]);
 * ```
 *
 * La cible est rendue **tant qu'elle n'est pas atteinte**, jamais consommée à la
 * lecture : une feature dont les données n'ont pas encore chargé la retrouvera au
 * rendu suivant, sans rien avoir à acquitter.
 *
 * `null` en `value` retire le niveau, et referme du même coup tout ce qui est en
 * dessous : on ne peut pas être dans un dossier sans être dans le compte qui le
 * contient.
 */
export function useLiveSegment(kind: LiveSegmentKind, value: string | null): LiveSegmentTarget | null {
    const { teleportPath } = useLive();

    useEffect(() => {
        setLiveSegment(kind, value);
        // Au démontage le niveau disparaît : une feature fermée n'est plus un
        // lieu. Le rétablissement éventuel viendra du composant qui reprend.
        return () => setLiveSegment(kind, null);
    }, [kind, value]);

    return useMemo(() => segmentTarget(teleportPath, kind, value), [teleportPath, kind, value]);
}
