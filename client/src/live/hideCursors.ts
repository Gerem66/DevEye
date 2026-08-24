import type { UserSettingFlag } from '@deveye/types';

import { useAuth } from '@/auth/AuthProvider';

/**
 * Le réglage « ne pas voir les curseurs des autres », posé depuis le profil.
 *
 * Il est **réciproque**, et c'est le point à ne pas perdre de vue en le lisant :
 * il ne coupe pas seulement l'affichage (`LiveCursors`), il coupe aussi
 * l'émission (`LiveProvider`). On ne peut donc pas regarder sans être vu — ce
 * qui est la seule forme défendable pour un réglage de présence partagée.
 *
 * Le drapeau vit sur le compte (`users.settings`) et non dans le navigateur : il
 * suit la personne, pas la machine.
 */
export const HIDE_LIVE_CURSORS: UserSettingFlag = 'hideLiveCursors';

/** `true` si le compte courant a coupé les curseurs. Faux hors session. */
export function useHideLiveCursors(): boolean {
    const { user } = useAuth();
    return user?.settings.includes(HIDE_LIVE_CURSORS) ?? false;
}
