import type { UserSettingFlag } from '@deveye/types';

import { useAuth } from '@/auth/AuthProvider';

/**
 * Le réglage « ne pas voir les curseurs des autres ». Réciproque : il coupe
 * l'affichage (`LiveCursors`) comme l'émission (`LiveProvider`), on ne regarde
 * donc pas sans être vu. Le drapeau vit sur le compte (`users.settings`) et non
 * dans le navigateur : il suit la personne, pas la machine.
 */
export const HIDE_LIVE_CURSORS: UserSettingFlag = 'hideLiveCursors';

/** `true` si le compte courant a coupé les curseurs. Faux hors session. */
export function useHideLiveCursors(): boolean {
    const { user } = useAuth();
    return user?.settings.includes(HIDE_LIVE_CURSORS) ?? false;
}
