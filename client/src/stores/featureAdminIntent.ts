import { useSyncExternalStore } from 'react';
import type { UserRole } from '@deveye/types';

import { getCurrentUser } from './currentUser';
import { requestOpenView } from './viewRequest';

/** La porte de la popup d'administration des fonctionnalités, selon le rôle : une seule par compte. */
export function featureAdminDoor(role: UserRole): 'features' | 'moderation' | null {
    if (role === 'admin') return 'features';
    return role === 'moderator' ? 'moderation' : null;
}

/** La fonctionnalité sur laquelle la popup doit se poser, en attendant qu'elle la lise. */
let target: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

/**
 * Ouvre la porte du rôle posée sur cette fonctionnalité, sur son premier onglet
 * de modération (le lien d'un mail de signalement). La popup lit la demande
 * qu'elle soit déjà ouverte ou non. Sans rôle qui modère, rien.
 */
export function openFeatureAdmin(featureId: string): void {
    const user = getCurrentUser();
    const door = user ? featureAdminDoor(user.role) : null;
    if (!door) return;
    target = featureId;
    emit();
    requestOpenView(door);
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
