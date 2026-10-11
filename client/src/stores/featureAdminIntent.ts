import { useSyncExternalStore } from 'react';
import { canModerate } from '@deveye/types';

import { getCurrentUser } from './currentUser';
import { requestOpenView } from './viewRequest';

/** La fonctionnalité sur laquelle la popup doit se poser, en attendant qu'elle la lise. */
let target: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

/**
 * Ouvre « Modération » posée sur cette fonctionnalité, sur son premier onglet
 * de modération (le lien d'un mail de signalement). La popup lit la demande
 * qu'elle soit déjà ouverte ou non. Sans rôle qui modère, rien.
 */
export function openFeatureAdmin(featureId: string): void {
    const user = getCurrentUser();
    if (!user || !canModerate(user.role)) return;
    target = featureId;
    emit();
    requestOpenView('moderation');
}

/** La demande lue : la popup l'efface pour qu'une réouverture reparte de son propre choix. */
export function clearFeatureAdminTarget(): void {
    if (target === null) return;
    target = null;
    emit();
}

const getTarget = (): string | null => target;

export function useFeatureAdminTarget(): string | null {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        getTarget,
        getTarget
    );
}
